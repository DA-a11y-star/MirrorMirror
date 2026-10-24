"""Resolve a small relationship vocabulary, then center, scale and ground an assembly."""

import math
import uuid

from voice.schema import VALIDATOR


def quaternion(rotation):
    # Matches THREE.Euler(x, y, z, 'XYZ').
    x, y, z = [math.radians(value) / 2 for value in rotation]
    a, b, c, d, e, f = math.sin(x), math.cos(x), math.sin(y), math.cos(y), math.sin(z), math.cos(z)
    return [a*d*f + b*c*e, b*c*f - a*d*e, b*d*e + a*c*f, b*d*f - a*c*e]


def half_extents(size, q):
    x, y, z, w = q
    matrix = [
        [1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
        [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
        [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)],
    ]
    return [sum(abs(row[j]) * size[j] / 2 for j in range(3)) for row in matrix]


def resolve(plan):
    VALIDATOR.validate(plan)
    for part in plan["parts"]:
        if not all(math.isfinite(value) for field in ("size", "position", "rotation") for value in part[field]):
            raise ValueError("All dimensions and transforms must be finite")
        if not math.isfinite(part["inset"]):
            raise ValueError("Inset must be finite")
    if plan["maxDimension"] is not None and not math.isfinite(plan["maxDimension"]):
        raise ValueError("Object size must be finite")
    source = {part["id"]: part for part in plan["parts"]}
    if len(source) != len(plan["parts"]):
        raise ValueError("Part IDs must be unique")
    resolved, visiting = {}, set()

    def visit(key):
        if key in resolved:
            return resolved[key]
        if key in visiting:
            raise ValueError("Placement relationships must not form a cycle")
        if key not in source:
            raise ValueError(f"Unknown placement target: {key}")
        visiting.add(key)
        part = source[key]
        q = quaternion(part["rotation"])
        half = half_extents(part["size"], q)
        positions = [part["position"][:]]
        relation = part["placement"]
        if relation != "absolute":
            targets = visit(part["target"])
            if len(targets) != 1:
                raise ValueError("A placement target cannot be a repeated part")
            target = targets[0]
            th = half_extents(target["size"], target["quaternion"])
            center = target["position"][:]
            if relation == "corners_below":
                dx, dz = th[0] - half[0] - part["inset"], th[2] - half[2] - part["inset"]
                if min(dx, dz) < 0:
                    raise ValueError("Corner parts and inset must fit underneath their target")
                positions = [[center[0]+sx*dx, center[1]-th[1]-half[1], center[2]+sz*dz]
                             for sx, sz in [(-1, -1), (-1, 1), (1, -1), (1, 1)]]
            else:
                axis, direction = {"above": (1, 1), "below": (1, -1), "left": (0, -1),
                                   "right": (0, 1), "front": (2, 1), "back": (2, -1)}[relation]
                center[axis] += direction * (th[axis] + half[axis])
                positions = [center]
            positions = [[p[i] + part["position"][i] for i in range(3)] for p in positions]
        result = [{"id": key if len(positions) == 1 else f"{key}-{i+1}", "shape": part["shape"],
                   "size": part["size"][:], "position": p, "quaternion": q[:], "color": part["color"]}
                  for i, p in enumerate(positions)]
        visiting.remove(key)
        resolved[key] = result
        return result

    parts = [part for key in source for part in visit(key)]
    if len(parts) > 40:
        raise ValueError("Assembly exceeds 40 parts after repetition")
    if len({p["id"] for p in parts}) != len(parts):
        raise ValueError("Expanded part IDs collide")
    low, high = [math.inf]*3, [-math.inf]*3
    for part in parts:
        half = half_extents(part["size"], part["quaternion"])
        for i in range(3):
            low[i] = min(low[i], part["position"][i] - half[i])
            high[i] = max(high[i], part["position"][i] + half[i])
    scale = (plan["maxDimension"] or 0.8) / max(high[i]-low[i] for i in range(3))
    origin = [(low[0]+high[0])/2, low[1], (low[2]+high[2])/2]
    for part in parts:
        part["size"] = [value * scale for value in part["size"]]
        part["position"] = [(part["position"][i]-origin[i]) * scale for i in range(3)]
    return {"version": 1, "id": f"generated-{uuid.uuid4().hex[:12]}", "name": plan["name"],
            "position": [0, 0, 0], "quaternion": [0, 0, 0, 1], "parts": parts}

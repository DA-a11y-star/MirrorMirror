"""Schema sent to Muse Wonder and validated again before layout."""

from jsonschema import Draft202012Validator


def vector(minimum=-20, maximum=20):
    return {"type": "array", "items": {"type": "number", "minimum": minimum, "maximum": maximum},
            "minItems": 3, "maxItems": 3}


PART = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "id": {"type": "string", "pattern": "^[a-z][a-z0-9_-]{0,39}$"},
        "shape": {"type": "string", "enum": ["box", "sphere", "cylinder", "cone"]},
        "size": vector(0.005, 10),
        "position": vector(),
        "rotation": vector(-360, 360),
        "color": {"type": "string", "pattern": "^#[0-9a-fA-F]{6}$"},
        "placement": {"type": "string", "enum": ["absolute", "above", "below", "left", "right", "front", "back", "corners_below"]},
        "target": {"type": "string", "maxLength": 40},
        "inset": {"type": "number", "minimum": 0, "maximum": 5},
    },
    "required": ["id", "shape", "size", "position", "rotation", "color", "placement", "target", "inset"],
}

PLAN_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "name": {"type": "string", "minLength": 1, "maxLength": 100},
        "maxDimension": {"type": ["number", "null"], "minimum": 0.1, "maximum": 3},
        "parts": {"type": "array", "minItems": 1, "maxItems": 40, "items": PART},
    },
    "required": ["name", "maxDimension", "parts"],
}

VALIDATOR = Draft202012Validator(PLAN_SCHEMA)

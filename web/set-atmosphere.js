import * as THREE from 'three';

// Shared by the mirrors and the workspace. A camera-centred sky costs one draw; the ridges are real world-space
// silhouettes, so nearby roofs move against them with head parallax. No extra lights or shadow passes.
export function buildSetAtmosphere(scene, set) {
  const group = new THREE.Group(); group.name = 'set-atmosphere';
  const sky = set.environment?.sky;
  let dome = null;
  if (sky) {
    dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 12), new THREE.ShaderMaterial({
      uniforms: { uTop: { value: new THREE.Color(sky[0]) }, uHorizon: { value: new THREE.Color(sky[1]) }, uTime: { value: 0 }, uMoon: { value: set.horizon ? 1 : 0 } },
      vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform vec3 uTop; uniform vec3 uHorizon; uniform float uTime; uniform float uMoon; varying vec3 vDir;
        void main() {
          vec3 d = normalize(vDir); float y = max(d.y, 0.0);
          vec3 col = mix(uHorizon, uTop, pow(y, 0.55));
          float cloud = sin(d.x * 13.0 + uTime * 0.008 + sin(d.z * 11.0)) * sin(d.z * 19.0 - uTime * 0.005);
          col = mix(col, uHorizon, smoothstep(0.35, 0.8, cloud) * exp(-pow((y - 0.18) * 8.0, 2.0)) * 0.16);
          float moon = dot(d, normalize(vec3(-0.35, 0.32, -1.0)));
          col += vec3(0.8, 0.65, 0.4) * (smoothstep(0.9992, 0.9994, moon) * 0.7 + pow(max(moon,0.0),180.0) * 0.06) * uMoon;
          gl_FragColor = vec4(col,1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      side: THREE.BackSide, depthWrite: false, depthTest: false,
    }));
    dome.renderOrder = -1000; dome.frustumCulled = false; group.add(dome);
  }
  if (set.horizon) {
    const { center = [0, 9] } = set.horizon;
    [0x51586a, 0x646677, 0x797988].forEach((color, ring) => {
      const mesh = new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 5), new THREE.MeshBasicMaterial({ color }), 16);
      const matrix = new THREE.Matrix4(), q = new THREE.Quaternion();
      for (let i = 0; i < 16; i++) {
        const angle = i / 16 * Math.PI * 2 + ring * 0.23;
        const r = 72 + ring * 16, h = 14 + ring * 3 + Math.sin(i * 7.13 + ring) * 6;
        matrix.compose(new THREE.Vector3(center[0] + Math.cos(angle) * r, h / 2 - 3, center[1] + Math.sin(angle) * r), q, new THREE.Vector3(19, h, 14));
        mesh.setMatrixAt(i, matrix);
      }
      mesh.computeBoundingSphere(); group.add(mesh);
    });
  }
  group.traverse(node => { node.userData.scenery = true; }); scene.add(group);
  return {
    group,
    update(seconds, camera) {
      if (!dome || !camera) return;
      dome.position.copy(camera.position);
      dome.scale.setScalar(Math.max(1, camera.far * 0.45));
      dome.material.uniforms.uTime.value = seconds;
    },
    dispose() {
      group.traverse(node => { node.geometry?.dispose(); node.material?.dispose(); if (node.isInstancedMesh) node.dispose(); });
      group.removeFromParent();
    },
  };
}

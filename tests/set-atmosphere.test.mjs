import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as THREE from '../web/vendor/three.module.js';
import { load } from './load.mjs';

const { buildSetAtmosphere } = await load('set-atmosphere');

test('shared atmosphere follows the eye camera, stays inside its far plane, and disposes cleanly', () => {
  const scene = new THREE.Scene();
  const effect = buildSetAtmosphere(scene, { environment: { sky: [0x292b55, 0xc18d7d] }, horizon: {} });
  assert.equal(effect.group.children.length, 4, 'one sky and three instanced mountain layers');
  const camera = new THREE.PerspectiveCamera(55, 1, 0.05, 140);
  camera.position.set(12, 3, -4); effect.update(20, camera);
  const sky = effect.group.children[0];
  assert.deepEqual(sky.position.toArray(), camera.position.toArray());
  assert.ok(sky.scale.x < camera.far);
  assert.equal(sky.material.depthWrite, false);
  assert.equal(sky.material.uniforms.uTime.value, 20);
  effect.group.traverse(n => assert.equal(n.userData.scenery, true));
  let disposed = 0; sky.geometry.addEventListener('dispose', () => disposed++);
  effect.dispose(); assert.equal(scene.children.length, 0); assert.equal(disposed, 1);
});

test('other sets get no invented sky or mountains', () => {
  const scene = new THREE.Scene(), effect = buildSetAtmosphere(scene, {});
  assert.equal(effect.group.children.length, 0); effect.update(0); effect.dispose();
});

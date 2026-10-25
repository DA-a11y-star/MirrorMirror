# Asset credits

Models in `web/assets/` are third-party work used under their licenses. Keep this list current; CC BY requires
credit wherever the work is shown.

| Folder | Work | Author | License |
|---|---|---|---|
| `cyberpunk/` | [Cyberpunk City - #1](https://sketchfab.com/3d-models/cyberpunk-city-1-14d2eaa145ee42938e004115871adf6c) | born2012 | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| `japanese-garden/` | [KyleS-Japanese Garden](https://sketchfab.com/3d-models/kyles-japanese-garden-4dd4ed4b77e04cb1ae374eae1e19f015) | ksayavanh2023 | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| `chinese-city/` | [Low poly Chinese city](https://sketchfab.com/3d-models/low-poly-chinese-city-faf480ecd57d4c8e9a2836f5c02c4d00) | smooth998 | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| `cyberpunk/` (`car_2_detailed.glb`) | [Car 2 detailed](https://sketchfab.com/3d-models/car-2-detailed-11567378b9e24679a3c0105b97cb8f5a) | iskandar1ch | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| `cyberpunk/` (`eve_from_wall-e.glb`) | [Eve from Wall-E](https://sketchfab.com/3d-models/eve-from-wall-e-c3acb81e214f4fc78bb3251339c2adc9) | ehockett | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| `cyberpunk/` (`airship.glb`) | [Airship](https://sketchfab.com/3d-models/airship-7e749c4115af497a85d39265b3a33ae5) | Shinsin | [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/) |
| `neighbourhood/` | [Neighbourhood City Modular lowpoly](https://sketchfab.com/3d-models/neighbourhood-city-modular-lowpoly-6a0e3b97a8a54f2a909d351322916293) | golukumar | [Sketchfab Standard](https://sketchfab.com/licenses) |

Changes to the Chinese city (CC BY asks for these to be stated): the 200 m ground plane was removed, the 5,592 separate meshes were merged by material into 14, vertices were welded and the stored normals dropped (three.js flat-shades a mesh without them, as the original looked). Geometry was not simplified.

Wall-E in the cyberpunk set is built from primitives in `web/props.js`; it uses no model.

Changes to the Neighbourhood (the licence asks for none to be hidden, so they are listed): the 70 MB download had 1,321 separate meshes, 60 textures and six UV sets with tangents. It was processed once to `web/assets/neighbourhood/neighbourhood_city.glb` (17.6 MB, 25 draw calls, 415k triangles): meshes merged by material, vertices welded, tangents and extra UV sets dropped, the normal, occlusion and metal/rough maps dropped (colour and glow maps kept, resized to 512 and 256 px and stored as WebP), materials made matte, and positions, normals and UVs quantized (`KHR_mesh_quantization`). Geometry was not simplified.

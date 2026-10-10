using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Creates ordinary editable assets once; opening an existing scene preserves edits.</summary>
    public static class PrototypeSceneBuilder
    {
        public const string ScenePath = "Assets/_Project/Scenes/Clearing.unity";

        [MenuItem("Zhiv/Create or Open 3D Clearing", priority = 0)]
        public static void CreateOrOpen()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                Debug.LogWarning("Сначала останови Play Mode.");
                return;
            }
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            if (File.Exists(ScenePath))
            {
                EditorSceneManager.OpenScene(ScenePath);
                return;
            }
            CreateScene();
        }

        // Also callable with -executeMethod after the Editor and packages have been installed.
        public static void CreateForBatch()
        {
            if (!File.Exists(ScenePath)) CreateScene();
        }

        private static void CreateScene()
        {
            EnsureFolder("Assets/_Project/Scenes");
            string generated = AssetDatabase.GenerateUniqueAssetPath("Assets/_Project/Generated");
            EnsureFolder(generated);
            EnsureFolder(generated + "/Rendering");
            EnsureFolder(generated + "/Art");
            try
            {
                PrototypePipelineSetup.Configure(generated + "/Rendering");
                PrototypeArtSet art = PrototypeArtFactory.Create(generated + "/Art");
                Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                var bounds = new Bounds(Vector3.zero, new Vector3(28f, 4f, 34f));

                var terrain = new GameObject("Terrain").transform;
                var buildings = new GameObject("Buildings").transform;
                var nature = new GameObject("Nature").transform;
                var lighting = new GameObject("Lighting").transform;
                var systems = new GameObject("World Systems");

                Cube("Ground", terrain, new Vector3(0, -.4f, 0), new Vector3(28, .8f, 34), art.Grass, 8);
                // Layout sketch: workshop west of home, open paths and water to the southeast.
                // This is a small study based on the old map, not a complete Tiled conversion.
                GameObject workshop = Place(art.Workshop, "Workshop", buildings, new Vector3(-6, 0, 4));
                Place(art.Home, "Home", buildings, new Vector3(3, 0, 5));
                Path(terrain, art.Path, new[] {
                    new Vector3(-6, 0, 1.6f), new Vector3(-6, 0, -2),
                    new Vector3(0, 0, -3), new Vector3(3, 0, -1), new Vector3(3, 0, 2.8f)
                }, 1.7f);
                Path(terrain, art.Path, new[] {
                    new Vector3(0, 0, -3), new Vector3(0, 0, -9), new Vector3(4, 0, -12)
                }, 1.5f);

                // An opaque shallow pond avoids transparent sorting and is blocked for walking.
                GameObject pond = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                pond.name = "Pond";
                pond.transform.SetParent(terrain, false);
                pond.transform.position = new Vector3(9, .012f, -7);
                pond.transform.localScale = new Vector3(6, .015f, 8);
                pond.GetComponent<Renderer>().sharedMaterial = art.Water;
                UnityEngine.Object.DestroyImmediate(pond.GetComponent<Collider>());
                var pondBoundary = new GameObject("Pond walking boundary");
                pondBoundary.transform.SetParent(terrain, false);
                pondBoundary.transform.position = new Vector3(9, .4f, -7);
                var pondBlocker = pondBoundary.AddComponent<BoxCollider>();
                pondBlocker.size = new Vector3(6, .8f, 8);
                pondBoundary.layer = 9;

                Vector3[] trees = {
                    new Vector3(-11,0,-5), new Vector3(-12,0,0), new Vector3(-11,0,6),
                    new Vector3(-10,0,11), new Vector3(-6,0,13), new Vector3(-2,0,12),
                    new Vector3(2,0,14), new Vector3(6,0,12), new Vector3(10,0,11),
                    new Vector3(12,0,6), new Vector3(11,0,1), new Vector3(12,0,-13)
                };
                var random = new System.Random(68);
                for (int i = 0; i < trees.Length; i++)
                {
                    var tree = Place(art.Tree, "Tree " + (i + 1), nature, trees[i]);
                    tree.transform.localScale = Vector3.one * (.85f + (float)random.NextDouble() * .35f);
                    tree.transform.rotation = Quaternion.Euler(0, (float)random.NextDouble() * 360, 0);
                }
                Vector3[] rocks = {
                    new Vector3(-9,0,-9), new Vector3(-8,0,8), new Vector3(7,0,9),
                    new Vector3(5.5f,0,-4), new Vector3(7,0,-11.5f), new Vector3(11,0,-11.5f),
                    new Vector3(-3,0,5), new Vector3(-4,0,-11)
                };
                for (int i = 0; i < rocks.Length; i++)
                    Place(art.Rock, "Rock " + (i + 1), nature, rocks[i]);

                var sunObject = new GameObject("Sun");
                sunObject.transform.SetParent(lighting, false);
                sunObject.transform.rotation = Quaternion.Euler(48, -35, 0);
                var sun = sunObject.AddComponent<Light>();
                sun.type = LightType.Directional;
                sun.color = new Color(1, .89f, .71f);
                sun.intensity = 1.25f;
                sun.shadows = LightShadows.Soft;
                sun.shadowBias = .025f;
                sun.shadowNormalBias = .25f;
                RenderSettings.sun = sun;
                RenderSettings.ambientMode = AmbientMode.Trilight;
                RenderSettings.ambientSkyColor = new Color(.5f, .61f, .66f);
                RenderSettings.ambientEquatorColor = new Color(.28f, .37f, .29f);
                RenderSettings.ambientGroundColor = new Color(.16f, .2f, .15f);
                RenderSettings.fog = false;

                var cameraObject = new GameObject("Main Camera");
                cameraObject.tag = "MainCamera";
                var camera = cameraObject.AddComponent<Camera>();
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(.13f, .22f, .2f);
                camera.nearClipPlane = .1f;
                camera.farClipPlane = 120;
                cameraObject.AddComponent<AudioListener>();
                var worldCamera = cameraObject.AddComponent<FixedWorldCamera>();
                worldCamera.Configure(new Vector3(-1, 0, 1), bounds, 11);

                var navigator = systems.AddComponent<GridNavigator>();
                navigator.Configure(bounds, .5f, 1 << 9);
                GameObject hero = Place(art.Actor, "Mochlik — 3D proxy", null, new Vector3(0, 0, -1));
                var actor = hero.AddComponent<WorldActorController>();
                actor.Configure(navigator);
                actor.SetVisual(hero.transform.Find("Visual"));
                var interaction = systems.AddComponent<DemoInteraction>();
                interaction.Configure(worldCamera, actor, workshop.transform, sun);
                Transform hammer = workshop.transform.Find("HammerPivot");
                if (hammer != null) interaction.SetWorkshopActivityTarget(hammer);

                Physics.SyncTransforms();
                if (!EditorSceneManager.SaveScene(scene, ScenePath))
                    throw new IOException("Не удалось сохранить сцену " + ScenePath);
                EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
                AssetDatabase.SaveAssets();
                Selection.activeGameObject = workshop;
                SceneView.lastActiveSceneView?.LookAt(new Vector3(-1, 0, 1), Quaternion.Euler(45, 45, 0), 18);
                Debug.Log("Поляна создана. Открой Game, поставь 9:16 и нажми Play. Объекты и материалы можно редактировать и сохранять.");
            }
            catch (Exception)
            {
                Debug.LogError("Создание поляны не завершилось. Предыдущие папки не удалены. Исправь первую ошибку Console и повтори Zhiv/Create or Open 3D Clearing.");
                throw;
            }
        }

        private static GameObject Place(GameObject prefab, string name, Transform parent, Vector3 position)
        {
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            instance.name = name;
            instance.transform.SetParent(parent, false);
            instance.transform.position = position;
            return instance;
        }

        private static void Cube(string name, Transform parent, Vector3 position, Vector3 scale, Material material, int layer)
        {
            var cube = GameObject.CreatePrimitive(PrimitiveType.Cube);
            cube.name = name;
            cube.transform.SetParent(parent, false);
            cube.transform.position = position;
            cube.transform.localScale = scale;
            cube.layer = layer;
            cube.GetComponent<Renderer>().sharedMaterial = material;
        }

        private static void Path(Transform parent, Material material, Vector3[] points, float width)
        {
            for (int i = 0; i < points.Length; i++)
            {
                var joint = GameObject.CreatePrimitive(PrimitiveType.Cylinder);
                joint.name = "Path bend";
                joint.transform.SetParent(parent, false);
                joint.transform.position = points[i] + Vector3.up * .014f;
                joint.transform.localScale = new Vector3(width, .01f, width);
                joint.GetComponent<Renderer>().sharedMaterial = material;
                UnityEngine.Object.DestroyImmediate(joint.GetComponent<Collider>());
                if (i == 0) continue;
                Vector3 delta = points[i] - points[i - 1];
                var segment = GameObject.CreatePrimitive(PrimitiveType.Cube);
                segment.name = "Path segment";
                segment.transform.SetParent(parent, false);
                segment.transform.position = (points[i] + points[i - 1]) * .5f + Vector3.up * .014f;
                segment.transform.rotation = Quaternion.LookRotation(delta);
                segment.transform.localScale = new Vector3(width, .02f, delta.magnitude);
                segment.GetComponent<Renderer>().sharedMaterial = material;
                UnityEngine.Object.DestroyImmediate(segment.GetComponent<Collider>());
            }
        }

        private static void EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            string parent = path.Substring(0, path.LastIndexOf('/'));
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, System.IO.Path.GetFileName(path));
        }
    }
}

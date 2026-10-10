using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using UnityEngine.SceneManagement;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Creates a separate editable composition study; never replaces Clearing or an existing layout.</summary>
    public static class ForestLayoutSceneBuilder
    {
        public const string ScenePath = "Assets/_Project/Scenes/ForestLayout.unity";

        [MenuItem("Zhiv/Create or Open Forest Layout", priority = 1)]
        public static void CreateOrOpen()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                Debug.LogWarning("Сначала останови Play Mode.");
                return;
            }
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            if (File.Exists(ScenePath)) EditorSceneManager.OpenScene(ScenePath);
            else ExpandedForestSceneBuilder.CreateForBatch();
        }

        public static void CreateForBatch()
        {
            ExpandedForestSceneBuilder.CreateForBatch();
        }

        private static void CreateScene()
        {
            string previousPath = SceneManager.GetActiveScene().path;
            EnsureFolder("Assets/_Project/Scenes");
            string generated = AssetDatabase.GenerateUniqueAssetPath("Assets/_Project/ForestGenerated");
            EnsureFolder(generated);
            foreach (string directory in new[] { "Rendering", "Art", "Ground", "Ground/Materials", "Environment" })
                EnsureFolder(generated + "/" + directory);
            try
            {
                // Reuse the user's configured renderer and quality settings. A new composition
                // is not permission to reset rendering settings tuned in the previous scene.
                RenderPipelineAsset pipeline = QualitySettings.renderPipeline ?? GraphicsSettings.defaultRenderPipeline;
                if (pipeline == null) PrototypePipelineSetup.Configure(generated + "/Rendering");
                else if (!(pipeline is UniversalRenderPipelineAsset))
                    throw new InvalidOperationException("ForestLayout требует URP. Текущий Render Pipeline оставлен без изменений.");
                // Create ScriptableObject recipes only after scene switching and texture imports.
                Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                PrototypeArtSet art = PrototypeArtFactory.Create(generated + "/Art");
                GroundMaterialSet materials = GroundMaterialFactory.Create(generated + "/Ground/Materials");
                GroundRecipe recipe = ForestLayoutRecipe.Create(generated + "/Ground");
                var groundRoot = new GameObject("Terrain").transform;
                Terrain terrain = GroundTerrainBaker.Create(recipe, generated + "/Ground", materials.Layers, materials.Material);
                terrain.transform.SetParent(groundRoot, true);
                var buildings = new GameObject("Buildings").transform;
                var nature = new GameObject("Environment").transform;
                var lighting = new GameObject("Lighting").transform;
                var systems = new GameObject("World Systems");

                GameObject home = Place(art.Home, "Home", buildings, AtGround(terrain, ForestLayoutRecipe.Home.Center));
                GameObject workshop = Place(art.Workshop, "Workshop", buildings, AtGround(terrain, ForestLayoutRecipe.Workshop.Center));
                ForestEnvironmentResult environment = ForestEnvironmentBuilder.Build(terrain, recipe, art, nature, generated + "/Environment");
                AddLandmark(home.transform, ForestLayoutRecipe.Home, terrain);
                AddLandmark(workshop.transform, ForestLayoutRecipe.Workshop, terrain);
                AddLandmark(environment.Ruins, ForestLayoutRecipe.Ruins, terrain);
                AddLandmark(environment.Camp, ForestLayoutRecipe.Camp, terrain);
                AddLandmark(environment.Market, ForestLayoutRecipe.Market, terrain);
                AddLandmark(environment.Lookout, ForestLayoutRecipe.Lookout, terrain);
                var shore = new GameObject("Shore approach").transform;
                shore.SetParent(nature, false);
                shore.position = AtGround(terrain, ForestLayoutRecipe.Shore.Center);
                AddLandmark(shore, ForestLayoutRecipe.Shore, terrain);

                Light sun = CreateLighting(lighting);
                var cameraObject = new GameObject("Main Camera");
                cameraObject.tag = "MainCamera";
                var camera = cameraObject.AddComponent<Camera>();
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(.13f, .22f, .2f);
                camera.nearClipPlane = .1f;
                camera.farClipPlane = 150;
                cameraObject.AddComponent<AudioListener>();
                var worldCamera = cameraObject.AddComponent<FixedWorldCamera>();
                var bounds = new Bounds(new Vector3(0, 0, 0), new Vector3(recipe.Size.x, 4, recipe.Size.z));
                worldCamera.ConfigureViewLimits(4, 15);
                // Small inward margin covers the gentle relief above the camera's reference plane.
                var viewBounds = new Bounds(bounds.center, bounds.size - new Vector3(1, 0, 1));
                worldCamera.Configure(new Vector3(-2, 0, 4), viewBounds, 9);

                var navigator = systems.AddComponent<GridNavigator>();
                navigator.Configure(bounds, .65f, 1 << 9);
                navigator.ConfigureTerrain(terrain);
                GameObject hero = Place(art.Actor, "Mochlik — 3D proxy", null, AtGround(terrain, new Vector2(0, .5f)));
                var actor = hero.AddComponent<WorldActorController>();
                actor.Configure(navigator);
                actor.SetVisual(hero.transform.Find("Visual"));
                var interaction = systems.AddComponent<DemoInteraction>();
                interaction.Configure(worldCamera, actor, workshop.transform, sun);
                interaction.SetWorkshopActivityTarget(workshop.transform.Find("HammerPivot"));
                ForestHudBuilder.Create(interaction, worldCamera, home.transform, workshop.transform, shore);

                Physics.SyncTransforms();
                AssetDatabase.SaveAssets();
                if (!EditorSceneManager.SaveScene(scene, ScenePath))
                    throw new IOException("Не удалось сохранить сцену " + ScenePath);
                var scenes = new List<EditorBuildSettingsScene>(EditorBuildSettings.scenes);
                if (!scenes.Exists(entry => entry.path == ScenePath))
                {
                    scenes.Add(new EditorBuildSettingsScene(ScenePath, true));
                    EditorBuildSettings.scenes = scenes.ToArray();
                }
                Selection.activeGameObject = terrain.gameObject;
                SceneView.lastActiveSceneView?.LookAt(new Vector3(0, 0, 0), Quaternion.Euler(45, 45, 0), 35);
                Debug.Log("Лесная планировка сохранена отдельно от Clearing. Деревьев: " + environment.TreeCount +
                    ". Проверь Game 9:16 → Play; Zhiv/Validate Forest Layout проверит проходы между местами.");
            }
            catch (Exception)
            {
                Debug.LogError("Создание ForestLayout не завершилось. Созданные ассеты сохранены для диагностики. " +
                    "Прочитай первую ошибку Console. Повторная попытка создаст новую папку ForestGenerated.");
                if (!string.IsNullOrEmpty(previousPath) && File.Exists(previousPath))
                    EditorSceneManager.OpenScene(previousPath);
                throw;
            }
        }

        private static void AddLandmark(Transform root, ForestZoneDefinition zone, Terrain terrain)
        {
            if (root == null) throw new InvalidOperationException("Missing landmark: " + zone.Id);
            var marker = root.gameObject.AddComponent<ForestLandmark>();
            marker.Id = zone.Id;
            marker.DisplayName = zone.DisplayName;
            var arrival = new GameObject("Arrival — " + zone.Id).transform;
            arrival.SetParent(root, false);
            arrival.position = AtGround(terrain, zone.Entrance);
            marker.Arrival = arrival;
        }

        private static Vector3 AtGround(Terrain terrain, Vector2 point)
        {
            var result = new Vector3(point.x, 0, point.y);
            result.y = terrain.SampleHeight(result) + terrain.transform.position.y;
            return result;
        }

        private static GameObject Place(GameObject prefab, string name, Transform parent, Vector3 position)
        {
            var instance = (GameObject)PrefabUtility.InstantiatePrefab(prefab);
            instance.name = name;
            instance.transform.SetParent(parent, false);
            instance.transform.position = position;
            return instance;
        }

        private static Light CreateLighting(Transform parent)
        {
            var sunObject = new GameObject("Sun");
            sunObject.transform.SetParent(parent, false);
            sunObject.transform.rotation = Quaternion.Euler(48, -35, 0);
            Light sun = sunObject.AddComponent<Light>();
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
            return sun;
        }

        private static void EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            EnsureFolder(path.Substring(0, path.LastIndexOf('/')));
            AssetDatabase.CreateFolder(path.Substring(0, path.LastIndexOf('/')), Path.GetFileName(path));
        }
    }
}

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
using Zhiv.WorldPrototype.UI;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Explicit upgrade with an independent scene backup and entirely new generated assets.</summary>
    public static class ExpandedForestSceneBuilder
    {
        [MenuItem("Zhiv/Expand Forest Layout", priority = 2)]
        public static void Expand()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
            {
                Debug.LogWarning("Сначала останови Play Mode.");
                return;
            }
            if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            if (File.Exists(ForestLayoutSceneBuilder.ScenePath))
                EditorSceneManager.OpenScene(ForestLayoutSceneBuilder.ScenePath);
            var existing = Object.FindFirstObjectByType<ForestWorldMap>();
            if (existing != null && existing.Revision >= ForestWorldMap.CurrentRevision
                && existing.gameObject.scene.path == ForestLayoutSceneBuilder.ScenePath)
            {
                Selection.activeGameObject = existing.gameObject;
                Debug.Log("Большая карта уже создана. Редактируй эту сцену: повторное Expand не заменяет ручную расстановку.");
                return;
            }
            string backup = null;
            if (File.Exists(ForestLayoutSceneBuilder.ScenePath))
            {
                AssetDatabase.SaveAssets();
                EnsureFolder("Assets/_Project/SceneBackups");
                backup = AssetDatabase.GenerateUniqueAssetPath("Assets/_Project/SceneBackups/ForestLayout-before-expansion.unity");
                if (!AssetDatabase.CopyAsset(ForestLayoutSceneBuilder.ScenePath, backup))
                    throw new IOException("Не удалось сохранить копию прежней ForestLayout; расширение остановлено.");
            }
            CreateScene(backup);
        }

        public static void CreateForBatch()
        {
            if (!File.Exists(ForestLayoutSceneBuilder.ScenePath)) CreateScene(null);
        }

        private static void CreateScene(string backup)
        {
            string previousPath = SceneManager.GetActiveScene().path;
            string folder = AssetDatabase.GenerateUniqueAssetPath("Assets/_Project/ExpandedForest");
            EnsureFolder("Assets/_Project/Scenes");
            EnsureFolder(folder);
            foreach (string child in new[] { "Rendering", "Art", "Ground", "Ground/Materials", "Environment" })
                EnsureFolder(folder + "/" + child);
            try
            {
                EditorUtility.DisplayProgressBar("Большой лес", "Материалы и основа", .05f);
                RenderPipelineAsset pipeline = QualitySettings.renderPipeline ?? GraphicsSettings.defaultRenderPipeline;
                if (pipeline == null) PrototypePipelineSetup.Configure(folder + "/Rendering");
                else if (!(pipeline is UniversalRenderPipelineAsset))
                    throw new InvalidOperationException("Большой лес требует URP. Настройки рендера не изменены.");
                // Scene changes can unload ScriptableObjects referenced only by local variables.
                // Finish the scene switch and texture imports before creating the ground recipe.
                Scene scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
                PrototypeArtSet art = PrototypeArtFactory.Create(folder + "/Art");
                GroundMaterialSet materials = GroundMaterialFactory.Create(folder + "/Ground/Materials");
                GroundRecipe recipe = ExpandedForestDefinition.Create(folder + "/Ground");
                EditorUtility.DisplayProgressBar("Большой лес", "Рельеф, берег и дорожки", .2f);
                Terrain terrain = GroundTerrainBaker.Create(recipe, folder + "/Ground", materials.Layers, materials.Material, 513, 1024);
                terrain.name = "Ground Surface — 280 m";
                var systems = new GameObject("World Systems");
                var map = systems.AddComponent<ForestWorldMap>();
                map.Ground = terrain.GetComponent<GroundAuthoring>();
                map.WalkBoundary = new[] {
                    ExpandedForestDefinition.ToWorldXZ(new Vector2(-64, -72)),
                    ExpandedForestDefinition.ToWorldXZ(new Vector2(64, -72)),
                    ExpandedForestDefinition.ToWorldXZ(new Vector2(64, 72)),
                    ExpandedForestDefinition.ToWorldXZ(new Vector2(-64, 72))
                };
                Transform places = new GameObject("Places — build sites").transform;
                var landmarks = new List<ForestLandmark>();
                Transform home = null, workshop = null, shore = null;
                foreach (ExpandedForestZone zone in ExpandedForestDefinition.Zones)
                {
                    GameObject item = zone.Id == "home" ? Place(art.Home, places) :
                        zone.Id == "workshop" ? Place(art.Workshop, places) : new GameObject(zone.DisplayName);
                    item.name = zone.DisplayName + " [" + zone.Id + "]";
                    item.transform.SetParent(places, true);
                    item.transform.position = GroundPoint(terrain, zone.Center);
                    var marker = item.AddComponent<ForestLandmark>();
                    marker.Id = zone.Id;
                    marker.DisplayName = zone.DisplayName;
                    marker.Footprint = zone.Footprint;
                    marker.IsFuture = zone.Future;
                    marker.Purpose = Purpose(zone.Id);
                    var arrival = new GameObject("Arrival").transform;
                    arrival.SetParent(item.transform, false);
                    arrival.position = GroundPoint(terrain, zone.Entrance);
                    marker.Arrival = arrival;
                    AddSiteCorners(item.transform, zone, terrain, art.Path);
                    landmarks.Add(marker);
                    if (zone.Id == "home") home = item.transform;
                    if (zone.Id == "workshop") workshop = item.transform;
                    if (zone.Id == "fishing") shore = item.transform;
                }
                if (home == null || workshop == null || shore == null)
                    throw new InvalidOperationException("Карта требует home/workshop/fishing места.");
                map.Places = landmarks.ToArray();
                EditorUtility.DisplayProgressBar("Большой лес", "Лесные массивы и речные рукава", .45f);
                Transform environment = new GameObject("Environment — forest and coast").transform;
                ExpandedForestEnvironmentResult result = ExpandedForestEnvironment.Build(terrain, recipe, art, environment, folder + "/Environment");
                map.TreeCount = result.TreeCount;
                map.EditableTreeCount = result.EditableTreeCount;
                map.ForestPatchCount = result.ForestPatchCount;

                Light sun = CreateLight();
                var cameraObject = new GameObject("Main Camera");
                cameraObject.tag = "MainCamera";
                Camera camera = cameraObject.AddComponent<Camera>();
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(.13f, .22f, .2f);
                camera.nearClipPlane = .1f;
                camera.farClipPlane = 600;
                cameraObject.AddComponent<AudioListener>();
                var worldCamera = cameraObject.AddComponent<FixedWorldCamera>();
                worldCamera.ConfigureViewLimits(5, 22);
                worldCamera.Configure(home.position, new Bounds(Vector3.zero, new Vector3(276, 6, 276)), 11);
                worldCamera.ConfigureTravelBounds(new Bounds(Vector3.zero, new Vector3(192, 6, 192)));
                worldCamera.ConfigureOverview(Vector3.zero, 85);
                var navigation = systems.AddComponent<GridNavigator>();
                navigation.Configure(new Bounds(Vector3.zero, new Vector3(194, 6, 194)), .8f, 1 << 9);
                navigation.ConfigureWalkablePolygon(map.WalkBoundary);
                navigation.ConfigureTerrain(terrain);
                GameObject hero = Place(art.Actor, null);
                hero.name = "Mochlik — 3D proxy";
                Vector3 spawn = landmarks.Find(place => place.Id == "home").Arrival.position - Vector3.forward * 1.5f;
                hero.transform.position = navigation.ProjectToGround(spawn);
                var actor = hero.AddComponent<WorldActorController>();
                actor.Configure(navigation);
                actor.SetVisual(hero.transform.Find("Visual"));
                var interaction = systems.AddComponent<DemoInteraction>();
                interaction.Configure(worldCamera, actor, workshop, sun);
                interaction.SetWorkshopActivityTarget(workshop.Find("HammerPivot"));
                GameObject hud = ForestHudBuilder.Create(interaction, worldCamera, home, workshop, shore);
                ForestMapPanelBuilder.Create(hud.GetComponent<ForestHud>(), worldCamera, map.Places);
                Physics.SyncTransforms();
                AssetDatabase.SaveAssets();
                EditorUtility.DisplayProgressBar("Большой лес", "Проверка мест и проходов перед сохранением", .88f);
                ExpandedForestValidation.ValidateMap(map, true);
                if (!EditorSceneManager.SaveScene(scene, ForestLayoutSceneBuilder.ScenePath))
                    throw new IOException("Не удалось сохранить большую ForestLayout.");
                var builds = new List<EditorBuildSettingsScene>(EditorBuildSettings.scenes);
                if (!builds.Exists(entry => entry.path == ForestLayoutSceneBuilder.ScenePath))
                {
                    builds.Add(new EditorBuildSettingsScene(ForestLayoutSceneBuilder.ScenePath, true));
                    EditorBuildSettings.scenes = builds.ToArray();
                }
                Selection.activeGameObject = systems;
                SceneView.lastActiveSceneView?.LookAt(home.position, Quaternion.Euler(45, 45, 0), 32);
                Debug.Log("Большая карта сохранена: игровая область 128×144 м, окружение 280×280 м, 13 мест. " +
                    "Нажми Play: свободно тяни карту; кнопка Карта показывает все места. " +
                    (backup == null ? "" : "Прежняя сцена: " + backup));
            }
            catch
            {
                Debug.LogError("Расширение не завершилось. Исправь первую ошибку Console; исходная сцена и её ассеты сохранены. " +
                    "Новые ассеты оставлены для диагностики в " + folder);
                string restore = backup ?? previousPath;
                if (!string.IsNullOrEmpty(restore) && File.Exists(restore)) EditorSceneManager.OpenScene(restore);
                throw;
            }
            finally { EditorUtility.ClearProgressBar(); }
        }

        private static GameObject Place(GameObject prefab, Transform parent) =>
            (GameObject)PrefabUtility.InstantiatePrefab(prefab, parent);

        private static Vector3 GroundPoint(Terrain terrain, Vector2 point)
        {
            var p = new Vector3(point.x, 0, point.y);
            p.y = terrain.SampleHeight(p) + terrain.transform.position.y;
            return p;
        }

        private static void AddSiteCorners(Transform root, ExpandedForestZone zone, Terrain terrain, Material material)
        {
            Transform guide = new GameObject("Plot corners — editable footprint").transform;
            guide.SetParent(root, false);
            foreach (float x in new[] { -.5f, .5f })
            foreach (float z in new[] { -.5f, .5f })
            {
                GameObject stake = GameObject.CreatePrimitive(PrimitiveType.Cube);
                stake.name = "Site corner";
                stake.transform.SetParent(guide, false);
                Vector2 point = zone.Center + new Vector2(zone.Footprint.x * x, zone.Footprint.y * z);
                stake.transform.position = GroundPoint(terrain, point) + Vector3.up * .15f;
                stake.transform.localScale = new Vector3(.18f, .3f, .18f);
                stake.GetComponent<Renderer>().sharedMaterial = material;
                Object.DestroyImmediate(stake.GetComponent<Collider>());
            }
        }

        private static string Purpose(string id)
        {
            switch (id)
            {
                case "home": return "Главный дом; место для будущих уровней постройки.";
                case "workshop": return "Мастерская и рабочий двор.";
                case "quarry": return "Каменоломня и будущий вход в подземелье.";
                case "garden": return "Сад, кусты и сбор урожая.";
                case "upper-pass": return "Верхний проход и будущая зона исследования.";
                case "east-clearing": return "Восточная поляна под новую постройку.";
                case "camp": return "Костёр и место встречи персонажей.";
                case "warehouse": return "Кладовая и хозяйственный двор.";
                case "market": return "Рынок и будущий порт.";
                case "fishing": return "Подход к воде и будущая пристань для рыбалки.";
                case "lighthouse": return "Маяк на выступающем берегу.";
                default: return "Запас территории для будущего расширения.";
            }
        }

        private static Light CreateLight()
        {
            var root = new GameObject("Lighting").transform;
            var sunlight = new GameObject("Sun");
            sunlight.transform.SetParent(root, false);
            sunlight.transform.rotation = Quaternion.Euler(48, -35, 0);
            Light sun = sunlight.AddComponent<Light>();
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
            return sun;
        }

        private static void EnsureFolder(string path)
        {
            if (AssetDatabase.IsValidFolder(path)) return;
            string parent = path.Substring(0, path.LastIndexOf('/'));
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, Path.GetFileName(path));
        }
    }
}

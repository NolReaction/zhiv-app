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
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Explicit Blender art preview. Never replaces a place, its collider or authored assets.</summary>
    public static class HomeLevel1Preview
    {
        private const string ArtFolder = "Assets/_Project/Art/Buildings/HomeLevel1";
        private const string ModelPath = ArtFolder + "/HomeLevel1.fbx";
        private const string AtlasPath = ArtFolder + "/HomeLevel1_Albedo.png";
        private const string MaterialFolder = ArtFolder + "/Materials";
        public const string ScenePath = "Assets/_Project/Scenes/HomeLevel1Preview.unity";
        private const string PreviewName = "Home Level 1 — Blender preview";
        private const string ActionName = "Try Level 1 Home";
        private const string LitShader = "Universal Render Pipeline/Lit";

        [MenuItem("Zhiv/Try Level 1 Home", priority = 12)]
        public static void TryInOpenScene()
        {
            if (!CanAuthor()) return;
            var createdAssets = new List<string>();
            int undoGroup = -1;
            GameObject visual = null;
            try
            {
                ForestLandmark home = FindHome();
                Transform existing = home.transform.Find(PreviewName);
                if (existing != null)
                {
                    Require(HasModel(existing), "Имя примерки уже занято ручным объектом. Переименуй его; ничего не заменено.");
                    Selection.activeGameObject = existing.gameObject;
                    SceneView.lastActiveSceneView?.FrameSelected();
                    Debug.Log("[HomeLevel1] Примерка уже есть в этой сцене. Повторный вызов её не заменяет. " +
                        "Для отмены первой примерки используй Undo; ручные изменения сохраняются.");
                    return;
                }

                ModelData model = ValidateModel();
                List<Renderer> oldRenderers;
                List<Light> oldLights;
                FindUnmodifiedPrototypeVisual(home, out oldRenderers, out oldLights);
                MaterialSet materials = GetMaterials(model, false, createdAssets);

                Undo.IncrementCurrentGroup();
                undoGroup = Undo.GetCurrentGroup();
                Undo.SetCurrentGroupName(ActionName);
                visual = CreateVisual(model, materials, home.gameObject.scene, home.transform, true);
                // Record existing components after registering the new hierarchy: registering a
                // created object flushes previous Undo.RecordObject records.
                foreach (Renderer renderer in oldRenderers)
                {
                    Undo.RecordObject(renderer, ActionName);
                    renderer.enabled = false;
                    PrefabUtility.RecordPrefabInstancePropertyModifications(renderer);
                }
                foreach (Light light in oldLights)
                {
                    Undo.RecordObject(light, ActionName);
                    light.enabled = false;
                    PrefabUtility.RecordPrefabInstancePropertyModifications(light);
                }
                Undo.FlushUndoRecordObjects();
                Undo.CollapseUndoOperations(undoGroup);
                EditorSceneManager.MarkSceneDirty(home.gameObject.scene);
                Selection.activeGameObject = visual;
                SceneView.lastActiveSceneView?.FrameSelected();
                Debug.Log("[HomeLevel1] Blender-дом добавлен к существующему месту. Корень, BoxCollider, Arrival, " +
                    "камера и ручные дочерние объекты сохранены. Cmd+Z отменяет примерку. Сохрани сцену, если оставляешь дом.");
            }
            catch (Exception exception)
            {
                if (undoGroup >= 0) Undo.RevertAllDownToGroup(undoGroup);
                if (visual != null) Object.DestroyImmediate(visual);
                DeleteCreatedAssets(createdAssets);
                Debug.LogError("[HomeLevel1] Примерка не применена: " + exception.Message);
            }
        }

        [MenuItem("Zhiv/Preview Level 1 Home", priority = 11)]
        public static void OpenPreview()
        {
            if (!CanAuthor()) return;
            if (File.Exists(ScenePath))
            {
                if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
                EditorSceneManager.OpenScene(ScenePath);
                Debug.Log("[HomeLevel1] Открыта сохранённая сцена примерки. Её ручные изменения не заменяются.");
                return;
            }

            var createdAssets = new List<string>();
            Scene previous = SceneManager.GetActiveScene();
            Scene preview = default;
            bool saved = false;
            try
            {
                // Validate the FBX before creating materials or switching scenes.
                ModelData model = ValidateModel();
                ValidateExistingMaterials(true);
                if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
                MaterialSet materials = GetMaterials(model, true, createdAssets);
                EnsureFolder("Assets/_Project/Scenes");
                preview = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Additive);
                SceneManager.SetActiveScene(preview);
                CreateVisual(model, materials, preview, null, false);

                GameObject ground = GameObject.CreatePrimitive(PrimitiveType.Cube);
                ground.name = "Preview ground";
                ground.transform.position = new Vector3(0, -.06f, 0);
                ground.transform.localScale = new Vector3(9, .12f, 9);
                Object.DestroyImmediate(ground.GetComponent<Collider>());
                ground.GetComponent<Renderer>().sharedMaterial = materials.Ground;

                var sunObject = new GameObject("Preview sun");
                sunObject.transform.rotation = Quaternion.Euler(48, -35, 0);
                Light sun = sunObject.AddComponent<Light>();
                sun.type = LightType.Directional;
                sun.color = new Color(1, .89f, .71f);
                sun.intensity = 1.25f;
                sun.shadows = LightShadows.Soft;
                sun.shadowBias = .025f;
                sun.shadowNormalBias = .25f;
                RenderSettings.sun = sun;
                RenderSettings.ambientMode = AmbientMode.Flat;
                RenderSettings.ambientLight = new Color(.34f, .38f, .34f);
                RenderSettings.fog = false;

                var cameraObject = new GameObject("Main Camera");
                cameraObject.tag = "MainCamera";
                Camera camera = cameraObject.AddComponent<Camera>();
                cameraObject.AddComponent<AudioListener>();
                camera.orthographic = true;
                camera.orthographicSize = Mathf.Max(3.5f, model.ViewBounds.extents.y * 1.12f,
                    model.ViewBounds.extents.x * 1.12f / (9f / 16f));
                camera.aspect = 9f / 16f;
                camera.nearClipPlane = .1f;
                camera.farClipPlane = 100;
                camera.clearFlags = CameraClearFlags.SolidColor;
                camera.backgroundColor = new Color(.13f, .19f, .17f);
                cameraObject.transform.rotation = Quaternion.Euler(45, 45, 0);
                Vector3 cameraFocus = cameraObject.transform.rotation * model.ViewBounds.center;
                cameraObject.transform.position = cameraFocus - cameraObject.transform.forward * 14;

                Require(EditorSceneManager.SaveScene(preview, ScenePath), "Не удалось сохранить новую сцену примерки.");
                saved = true;
                EditorSceneManager.OpenScene(ScenePath);
                Selection.activeGameObject = GameObject.Find(PreviewName);
                SceneView.lastActiveSceneView?.LookAt(cameraFocus, Quaternion.Euler(45, 45, 0), 6);
                Debug.Log("[HomeLevel1] Сцена примерки сохранена: " + ScenePath +
                    ". Открой Game, выбери 9:16. Это отдельный просмотр модели без генерации леса или игровых систем.");
            }
            catch (Exception exception)
            {
                if (preview.IsValid() && preview.isLoaded) EditorSceneManager.CloseScene(preview, true);
                if (previous.IsValid() && previous.isLoaded) SceneManager.SetActiveScene(previous);
                if (saved)
                    Debug.LogError("[HomeLevel1] Сцена примерки сохранена, но открыть её не удалось: " + exception.Message +
                        ". Открой " + ScenePath + " из Project; созданные ассеты сохранены.");
                else
                {
                    DeleteCreatedAssets(createdAssets);
                    Debug.LogError("[HomeLevel1] Сцена примерки не создана: " + exception.Message +
                        ". Исходная сцена и существующие ассеты не заменены.");
                }
            }
        }

        [MenuItem("Zhiv/Try Level 1 Home", true)]
        private static bool ValidateTryMenu() => ValidateMenu();

        [MenuItem("Zhiv/Preview Level 1 Home", true)]
        private static bool ValidatePreviewMenu() => ValidateMenu();

        private static bool ValidateMenu()
        {
            return !EditorApplication.isPlayingOrWillChangePlaymode && !EditorApplication.isCompiling &&
                !EditorApplication.isUpdating;
        }

        private static bool CanAuthor()
        {
            if (ValidateMenu()) return true;
            Debug.LogWarning("[HomeLevel1] Останови Play и дождись окончания компиляции и импорта.");
            return false;
        }

        private static ForestLandmark FindHome()
        {
            var selected = Selection.activeGameObject;
            ForestLandmark home = selected != null ? selected.GetComponentInParent<ForestLandmark>() : null;
            Scene active = SceneManager.GetActiveScene();
            if (home == null || home.Id != "home" || home.gameObject.scene != active || EditorUtility.IsPersistent(home))
            {
                home = null;
                foreach (GameObject root in active.GetRootGameObjects())
                foreach (ForestLandmark place in root.GetComponentsInChildren<ForestLandmark>(true))
                {
                    if (place.Id != "home") continue;
                    Require(home == null, "В сцене несколько мест home. Выбери нужный дом в Hierarchy.");
                    home = place;
                }
            }
            Require(home != null, "В активной сцене нет места home. Открой ForestLayout или ForestBlockout, " +
                "либо посмотри модель через Zhiv → Preview Level 1 Home.");
            Require(home.Arrival != null && home.Arrival.IsChildOf(home.transform), "У дома отсутствует дочерний Arrival.");
            return home;
        }

        private static void FindUnmodifiedPrototypeVisual(ForestLandmark home, out List<Renderer> renderers,
            out List<Light> lights)
        {
            GameObject source = PrefabUtility.GetCorrespondingObjectFromOriginalSource(home.gameObject);
            Require(source != null && source.name == "Stump Home" && source.transform.Find("Living stump") != null &&
                source.transform.Find("Entrance shadow") != null, "Исходный визуал не распознан как prefab Stump Home. " +
                "Ручной дом не заменён; для отдельного просмотра используй Preview Level 1 Home.");
            Require(home.GetComponent<BoxCollider>() != null, "У дома нет исходного BoxCollider; примерка остановлена.");
            string sourcePath = AssetDatabase.GetAssetPath(source);
            renderers = new List<Renderer>();
            lights = new List<Light>();
            var prototypeObjects = new HashSet<Object>();
            foreach (Transform part in home.GetComponentsInChildren<Transform>(true))
            {
                if (part == home.transform) continue;
                Transform original = PrefabUtility.GetCorrespondingObjectFromOriginalSource(part);
                if (original == null || AssetDatabase.GetAssetPath(original) != sourcePath) continue;
                prototypeObjects.Add(original);
                prototypeObjects.Add(original.gameObject);
                foreach (Component component in part.GetComponents<Component>())
                {
                    if (component == null) continue;
                    Component originalComponent = PrefabUtility.GetCorrespondingObjectFromOriginalSource(component);
                    if (originalComponent == null || AssetDatabase.GetAssetPath(originalComponent) != sourcePath) continue;
                    prototypeObjects.Add(originalComponent);
                    if (component is Renderer renderer) renderers.Add(renderer);
                    else if (component is Light light) lights.Add(light);
                }
            }
            PropertyModification[] modifications = PrefabUtility.GetPropertyModifications(home.gameObject);
            if (modifications != null)
                foreach (PropertyModification modification in modifications)
                    Require(!prototypeObjects.Contains(modification.target), "У исходного визуала дома есть ручные prefab overrides. " +
                        "Примерка их не скрывает. Посмотри новый дом отдельно через Preview Level 1 Home.");
            Require(renderers.Count > 0, "Не найдены исходные Renderer дома; ручной визуал не изменён.");
        }

        private static ModelData ValidateModel()
        {
            RenderPipelineAsset pipeline = QualitySettings.renderPipeline ?? GraphicsSettings.defaultRenderPipeline;
            Require(pipeline is UniversalRenderPipelineAsset, "Для просмотра нужен настроенный URP проекта.");
            GameObject asset = AssetDatabase.LoadAssetAtPath<GameObject>(ModelPath);
            Texture2D atlas = AssetDatabase.LoadAssetAtPath<Texture2D>(AtlasPath);
            Shader shader = Shader.Find(LitShader);
            Require(asset != null, "Не импортирован " + ModelPath + ". Дождись импорта после pull.");
            Require(atlas != null && atlas.width >= 1024 && atlas.height >= 1024, "Не импортирован atlas 1024² или больше: " + AtlasPath);
            Require(shader != null, "URP/Lit недоступен; дождись установки пакетов проекта.");
            Require(asset.GetComponentsInChildren<Collider>(true).Length == 0 &&
                asset.GetComponentsInChildren<MonoBehaviour>(true).Length == 0 &&
                asset.GetComponentsInChildren<Light>(true).Length == 0 &&
                asset.GetComponentsInChildren<Camera>(true).Length == 0,
                "FBX должен содержать только статическую геометрию и точки привязки.");

            Transform origin = FindAnchor(asset, "GroundOrigin");
            Transform door = FindAnchor(asset, "DoorAnchor");
            Require(origin.position.sqrMagnitude < .0001f, "GroundOrigin импортирован не в (0,0,0); проверь pivot экспорта.");
            Vector3 front = door.position - origin.position;
            front.y = 0;
            Require(front.sqrMagnitude > .25f && IsFinite(front), "DoorAnchor не задаёт направление входа.");
            Quaternion orientation = Quaternion.Euler(0, 180f - Mathf.Atan2(front.x, front.z) * Mathf.Rad2Deg, 0);
            Matrix4x4 orient = Matrix4x4.Rotate(orientation);
            Bounds bounds = default;
            Bounds viewBounds = default;
            Quaternion viewRotation = Quaternion.Inverse(Quaternion.Euler(45, 45, 0));
            var vertices = new List<Vector3>();
            bool hasBounds = false;
            foreach (MeshFilter filter in asset.GetComponentsInChildren<MeshFilter>(true))
            {
                Require(filter.sharedMesh != null && EditorUtility.IsPersistent(filter.sharedMesh), "В FBX отсутствует сохранённый mesh.");
                Matrix4x4 matrix = orient * filter.transform.localToWorldMatrix;
                // Menu authoring runs outside Play/rendering; Editor mesh access does not
                // require enabling runtime Read/Write on the imported model.
                filter.sharedMesh.GetVertices(vertices);
                foreach (Vector3 vertex in vertices)
                {
                    Vector3 point = matrix.MultiplyPoint3x4(vertex);
                    Require(IsFinite(point), "FBX содержит некорректные координаты.");
                    Vector3 viewPoint = viewRotation * point;
                    if (!hasBounds)
                    {
                        bounds = new Bounds(point, Vector3.zero);
                        viewBounds = new Bounds(viewPoint, Vector3.zero);
                        hasBounds = true;
                    }
                    else
                    {
                        bounds.Encapsulate(point);
                        viewBounds.Encapsulate(viewPoint);
                    }
                }
            }
            Require(hasBounds && bounds.size.x > 2 && bounds.size.z > 2 && bounds.size.y > 2,
                "Масштаб FBX не соответствует метрам; ожидается дом около 3 м.");
            Require(bounds.min.y >= -.025f && bounds.max.y <= 3.95f && bounds.size.x <= 3.55f && bounds.size.z <= 3.55f &&
                Mathf.Abs(bounds.center.x) <= .2f && Mathf.Abs(bounds.center.z) <= .2f,
                "Импортированные габариты не соответствуют дому: " + bounds + ". Проверь метры, оси и ground pivot экспорта.");
            Renderer[] renderers = asset.GetComponentsInChildren<Renderer>(true);
            Require(renderers.Length > 0, "В FBX нет Renderer.");
            foreach (Renderer renderer in renderers)
            {
                Require(renderer is MeshRenderer, "Для этого дома поддерживается только статический MeshRenderer.");
                Require(renderer.sharedMaterials.Length > 0, "В FBX нет material slots.");
                foreach (Material material in renderer.sharedMaterials)
                    Require(material != null && (material.name == "HomeSurface" || material.name == "HomeGlow"),
                        "Material slot FBX должен называться HomeSurface или HomeGlow: " + renderer.name);
            }
            ValidateExistingMaterials(false);
            return new ModelData { Asset = asset, Atlas = atlas, Shader = shader, Orientation = orientation, ViewBounds = viewBounds };
        }

        private static Transform FindAnchor(GameObject asset, string name)
        {
            Transform found = null;
            foreach (Transform part in asset.GetComponentsInChildren<Transform>(true))
            {
                if (part.name != name) continue;
                Require(found == null, "В FBX повторяется точка " + name);
                found = part;
            }
            Require(found != null, "В FBX отсутствует точка " + name);
            return found;
        }

        private static void ValidateExistingMaterials(bool ground)
        {
            foreach (string name in ground ? new[] { "HomeSurface", "HomeGlow", "PreviewGround" } : new[] { "HomeSurface", "HomeGlow" })
            {
                string path = MaterialFolder + "/" + name + ".mat";
                Material material = AssetDatabase.LoadAssetAtPath<Material>(path);
                Require(!File.Exists(path) || material != null, "Путь материала занят другим ассетом: " + path);
                Require(material == null || (material.shader != null && material.shader.name == LitShader),
                    "Существующий материал использует другой shader и сохранён: " + path);
            }
        }

        private static MaterialSet GetMaterials(ModelData model, bool ground, List<string> created)
        {
            ValidateExistingMaterials(ground);
            EnsureFolder(MaterialFolder);
            return new MaterialSet
            {
                Surface = GetMaterial("HomeSurface", model.Shader, created, material =>
                {
                    material.SetTexture("_BaseMap", model.Atlas);
                    material.SetColor("_BaseColor", Color.white);
                    material.SetFloat("_Smoothness", .18f);
                    material.SetFloat("_Metallic", 0);
                }),
                Glow = GetMaterial("HomeGlow", model.Shader, created, material =>
                {
                    Color amber = new Color(239f / 255f, 179f / 255f, 95f / 255f);
                    material.SetColor("_BaseColor", amber);
                    material.SetFloat("_Smoothness", .25f);
                    material.SetFloat("_Metallic", 0);
                    material.EnableKeyword("_EMISSION");
                    material.SetColor("_EmissionColor", amber * 2);
                    material.globalIlluminationFlags = MaterialGlobalIlluminationFlags.None;
                }),
                Ground = ground ? GetMaterial("PreviewGround", model.Shader, created, material =>
                {
                    material.SetColor("_BaseColor", new Color(.27f, .32f, .245f));
                    material.SetFloat("_Smoothness", .06f);
                    material.SetFloat("_Metallic", 0);
                }) : null
            };
        }

        private static Material GetMaterial(string name, Shader shader, List<string> created, Action<Material> configure)
        {
            string path = MaterialFolder + "/" + name + ".mat";
            Material existing = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (existing != null) return existing;
            var material = new Material(shader) { name = name };
            try
            {
                configure(material);
                AssetDatabase.CreateAsset(material, path);
                created.Add(path);
                AssetDatabase.SaveAssetIfDirty(material);
                return material;
            }
            catch
            {
                if (!EditorUtility.IsPersistent(material)) Object.DestroyImmediate(material);
                throw;
            }
        }

        private static GameObject CreateVisual(ModelData model, MaterialSet materials, Scene scene, Transform parent,
            bool undo)
        {
            GameObject container = null;
            try
            {
                container = new GameObject(PreviewName);
                SceneManager.MoveGameObjectToScene(container, scene);
                if (undo) Undo.RegisterCreatedObjectUndo(container, ActionName);
                if (parent != null)
                {
                    if (undo) Undo.SetTransformParent(container.transform, parent, ActionName);
                    else container.transform.SetParent(parent, false);
                }
                var orientation = new GameObject("Imported orientation");
                if (undo)
                {
                    Undo.RegisterCreatedObjectUndo(orientation, ActionName);
                    Undo.SetTransformParent(orientation.transform, container.transform, ActionName);
                }
                else orientation.transform.SetParent(container.transform, false);
                GameObject instance = (GameObject)PrefabUtility.InstantiatePrefab(model.Asset, scene);
                Require(instance != null, "Не удалось создать instance FBX.");
                if (undo)
                {
                    Undo.RegisterCreatedObjectUndo(instance, ActionName);
                    Undo.SetTransformParent(instance.transform, orientation.transform, ActionName);
                }
                else instance.transform.SetParent(orientation.transform, false);
                if (undo) Undo.RegisterFullObjectHierarchyUndo(container, ActionName);

                container.transform.localPosition = Vector3.zero;
                container.transform.localRotation = Quaternion.identity;
                container.transform.localScale = Vector3.one;
                orientation.transform.localPosition = Vector3.zero;
                orientation.transform.localScale = Vector3.one;
                orientation.transform.localRotation = model.Orientation;
                // Keep the importer axis/unit transforms beneath our ground-pivot container.
                instance.transform.localPosition = model.Asset.transform.localPosition;
                instance.transform.localRotation = model.Asset.transform.localRotation;
                instance.transform.localScale = model.Asset.transform.localScale;
                foreach (Transform part in container.GetComponentsInChildren<Transform>(true))
                    part.gameObject.layer = parent != null ? parent.gameObject.layer : 0;
                foreach (Renderer renderer in instance.GetComponentsInChildren<Renderer>(true))
                {
                    Material[] imported = renderer.sharedMaterials;
                    for (int slot = 0; slot < imported.Length; slot++)
                        imported[slot] = imported[slot].name == "HomeGlow" ? materials.Glow : materials.Surface;
                    renderer.sharedMaterials = imported;
                    PrefabUtility.RecordPrefabInstancePropertyModifications(renderer);
                }
                PrefabUtility.RecordPrefabInstancePropertyModifications(instance.transform);
                foreach (Transform part in instance.GetComponentsInChildren<Transform>(true))
                    PrefabUtility.RecordPrefabInstancePropertyModifications(part.gameObject);
                return container;
            }
            catch
            {
                if (!undo && container != null) Object.DestroyImmediate(container);
                throw;
            }
        }

        private static bool HasModel(Transform root)
        {
            foreach (Transform part in root.GetComponentsInChildren<Transform>(true))
                if (PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(part.gameObject) == ModelPath) return true;
            return false;
        }

        private static void DeleteCreatedAssets(List<string> created)
        {
            for (int index = created.Count - 1; index >= 0; index--) AssetDatabase.DeleteAsset(created[index]);
        }

        private static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            int separator = folder.LastIndexOf('/');
            EnsureFolder(folder.Substring(0, separator));
            AssetDatabase.CreateFolder(folder.Substring(0, separator), folder.Substring(separator + 1));
        }

        private static bool IsFinite(Vector3 point)
        {
            return !float.IsNaN(point.x) && !float.IsInfinity(point.x) && !float.IsNaN(point.y) &&
                !float.IsInfinity(point.y) && !float.IsNaN(point.z) && !float.IsInfinity(point.z);
        }

        private static void Require(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private sealed class ModelData
        {
            public GameObject Asset;
            public Texture2D Atlas;
            public Shader Shader;
            public Quaternion Orientation;
            public Bounds ViewBounds;
        }

        private sealed class MaterialSet
        {
            public Material Surface;
            public Material Glow;
            public Material Ground;
        }
    }
}

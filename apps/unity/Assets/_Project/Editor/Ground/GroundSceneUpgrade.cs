using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Zhiv.WorldPrototype;
using Object = UnityEngine.Object;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Explicit, one-time upgrade. Author-created scenes and old ground remain recoverable.</summary>
    public static class GroundSceneUpgrade
    {
        [MenuItem("Zhiv/Upgrade Ground and Paths", priority = 5)]
        public static void UpgradeOpenClearing()
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Останови Play перед обновлением земли.");
            Scene scene = SceneManager.GetActiveScene();
            if (scene.path != PrototypeSceneBuilder.ScenePath)
                throw new InvalidOperationException("Сначала открой сцену Clearing через меню Zhiv.");
            var existing = Object.FindFirstObjectByType<GroundAuthoring>();
            if (existing != null)
            {
                Selection.activeGameObject = existing.gameObject;
                Debug.Log("Земля уже обновлена. Меняй точки тропинок и используй кнопки в Ground Authoring. Повторная генерация не выполнялась.");
                return;
            }

            Transform terrainGroup = null;
            foreach (GameObject root in scene.GetRootGameObjects())
                if (root.name == "Terrain") terrainGroup = root.transform;
            Transform oldGround = terrainGroup != null ? terrainGroup.Find("Ground") : null;
            var oldCollider = oldGround != null ? oldGround.GetComponent<BoxCollider>() : null;
            if (oldCollider == null || oldGround.gameObject.layer != 8 || Quaternion.Angle(oldGround.rotation, Quaternion.identity) > .01f)
                throw new InvalidOperationException("Не найдена исходная горизонтальная поверхность Terrain/Ground. Авторская сцена оставлена без изменений.");
            Physics.SyncTransforms();
            Bounds oldBounds = oldCollider.bounds;
            if (!EditorSceneManager.SaveScene(scene)) throw new IOException("Не удалось сохранить исходную сцену.");
            EnsureFolder("Assets/_Project/SceneBackups");
            string backup = AssetDatabase.GenerateUniqueAssetPath("Assets/_Project/SceneBackups/Clearing-before-ground.unity");
            if (!AssetDatabase.CopyAsset(scene.path, backup)) throw new IOException("Не удалось создать резервную копию сцены.");

            string folder = AssetDatabase.GenerateUniqueAssetPath("Assets/_Project/GroundGenerated");
            EnsureFolder(folder);
            EnsureFolder(folder + "/Materials");
            var recipe = ScriptableObject.CreateInstance<GroundRecipe>();
            recipe.name = "Clearing ground recipe";
            recipe.BaseHeight = oldBounds.max.y;
            recipe.Origin = new Vector3(oldBounds.min.x, recipe.BaseHeight - .8f, oldBounds.min.z);
            recipe.Size = new Vector3(oldBounds.size.x, 2, oldBounds.size.z);
            recipe.Trails = ReadTrails(terrainGroup);
            recipe.Pads = ReadPads(scene, recipe.BaseHeight);
            GroundPathMath.ValidateRecipe(recipe);
            AssetDatabase.CreateAsset(recipe, folder + "/GroundRecipe.asset");

            Terrain surface = null;
            Undo.IncrementCurrentGroup();
            int undoGroup = Undo.GetCurrentGroup();
            Undo.SetCurrentGroupName("Upgrade clearing ground");
            try
            {
                GroundMaterialSet materials = GroundMaterialFactory.Create(folder + "/Materials");
                // Texture imports may unload a ScriptableObject held only by this local variable.
                recipe = AssetDatabase.LoadAssetAtPath<GroundRecipe>(folder + "/GroundRecipe.asset");
                if (recipe == null)
                    throw new InvalidOperationException("Не удалось загрузить сохранённый рецепт земли: " + folder + "/GroundRecipe.asset");
                surface = GroundTerrainBaker.Create(recipe, folder, materials.Layers, materials.Material);
                Undo.RegisterCreatedObjectUndo(surface.gameObject, "Create terrain");
                surface.transform.SetParent(terrainGroup, true);
                var authoring = surface.GetComponent<GroundAuthoring>();
                authoring.Surface = surface;
                authoring.Recipe = recipe;
                EditorUtility.SetDirty(authoring);

                var legacy = new GameObject("Previous ground (disabled backup)");
                Undo.RegisterCreatedObjectUndo(legacy, "Keep previous ground");
                legacy.transform.SetParent(terrainGroup, false);
                var oldParts = new List<Transform>();
                foreach (Transform child in terrainGroup)
                    if (child == oldGround || child.name == "Path bend" || child.name == "Path segment") oldParts.Add(child);
                foreach (Transform child in oldParts) Undo.SetTransformParent(child, legacy.transform, "Preserve old ground");
                Undo.RecordObject(legacy, "Disable old surface");
                legacy.SetActive(false);

                foreach (GridNavigator navigator in Object.FindObjectsByType<GridNavigator>(FindObjectsSortMode.None))
                {
                    if (navigator.gameObject.scene != scene) continue;
                    Undo.RecordObject(navigator, "Use terrain navigation");
                    navigator.ConfigureTerrain(surface);
                    EditorUtility.SetDirty(navigator);
                }
                Physics.SyncTransforms();
                EditorSceneManager.MarkSceneDirty(scene);
                AssetDatabase.SaveAssets();
                if (!EditorSceneManager.SaveScene(scene)) throw new IOException("Не удалось сохранить обновлённую сцену.");
                Undo.CollapseUndoOperations(undoGroup);
                Selection.activeGameObject = surface.gameObject;
                Debug.Log("Земля обновлена. Выдели Ground Surface, двигай точки в Scene и нажимай Bake Layer Paint. Копия прежней сцены: " + backup);
            }
            catch
            {
                Undo.RevertAllDownToGroup(undoGroup);
                // Create can fail before returning its GameObject. Source scene backup is always intact.
                Debug.LogError("Обновление земли прервалось. Исходная сцена сохранена в " + backup + ". Новые ассеты оставлены для диагностики.");
                throw;
            }
        }

        private static List<GroundTrail> ReadTrails(Transform terrainGroup)
        {
            var points = new List<Vector2>();
            foreach (Transform child in terrainGroup)
                if (child.name == "Path bend") points.Add(new Vector2(child.position.x, child.position.z));
            if (points.Count != 8)
                throw new InvalidOperationException("Исходные тропинки изменены: ожидалось 8 узлов Path bend. Сцена сохранена, но автоматическая замена остановлена, чтобы не потерять твою разметку.");
            return new List<GroundTrail>
            {
                new GroundTrail { Name = "Workshop to home", Width = 1.2f, Feather = .48f, Points = points.GetRange(0, 5) },
                new GroundTrail { Name = "Southern trail", Width = 1.05f, Feather = .5f, Points = points.GetRange(5, 3) }
            };
        }

        private static List<GroundPad> ReadPads(Scene scene, float baseHeight)
        {
            var pads = new List<GroundPad>();
            foreach (Collider collider in Object.FindObjectsByType<Collider>(FindObjectsSortMode.None))
            {
                if (collider.gameObject.scene != scene || collider.gameObject.layer != 9 || collider.isTrigger) continue;
                Bounds b = collider.bounds;
                pads.Add(new GroundPad
                {
                    Name = collider.name,
                    Center = new Vector2(b.center.x, b.center.z),
                    Size = new Vector2(b.size.x + .5f, b.size.z + .5f),
                    Height = collider.name == "Pond walking boundary" ? baseHeight : collider.transform.position.y,
                    Feather = .9f
                });
            }
            return pads;
        }

        internal static void EnsureFolder(string folder)
        {
            if (AssetDatabase.IsValidFolder(folder)) return;
            string parent = folder.Substring(0, folder.LastIndexOf('/'));
            EnsureFolder(parent);
            AssetDatabase.CreateFolder(parent, Path.GetFileName(folder));
        }
    }
}

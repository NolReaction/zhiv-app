using System.Collections.Generic;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    [CustomEditor(typeof(GroundAuthoring))]
    public sealed class GroundAuthoringEditor : UnityEditor.Editor
    {
        private int activeTrail;
        private int activeForest;
        private int activeWater;
        private int handleGroup;
        private static readonly string[] HandleGroups = { "Trails", "Forest contours", "Water contours" };

        public override void OnInspectorGUI()
        {
            DrawDefaultInspector();
            var authoring = (GroundAuthoring)target;
            if (authoring.Recipe == null || authoring.Surface == null) return;
            EditorGUILayout.Space();
            EditorGUILayout.HelpBox("Точки — мировые X/Z. Width — полная ширина в метрах; Feather — мягкий край. Forest Regions задают темные массы леса, Water Regions — берег. После перемещения точек нажми Bake Layer Paint. Рельеф и ручная покраска не обновляются автоматически.", MessageType.Info);
            using (new EditorGUI.DisabledScope(EditorApplication.isPlayingOrWillChangePlaymode))
            {
                var recipeObject = new SerializedObject(authoring.Recipe);
                recipeObject.Update();
                SerializedProperty property = recipeObject.GetIterator();
                bool enterChildren = true;
                while (property.NextVisible(enterChildren))
                {
                    enterChildren = false;
                    if (property.name == "m_Script") continue;
                    using (new EditorGUI.DisabledScope(property.name == "Origin" || property.name == "Size"))
                        EditorGUILayout.PropertyField(property, true);
                }
                if (recipeObject.ApplyModifiedProperties()) SceneView.RepaintAll();

                handleGroup = EditorGUILayout.Popup("Edit outlines", handleGroup, HandleGroups);
                if (handleGroup == 0 && authoring.Recipe.Trails != null && authoring.Recipe.Trails.Count > 0)
                {
                    var names = authoring.Recipe.Trails.ConvertAll(trail => trail != null ? trail.Name : "Invalid trail").ToArray();
                    activeTrail = EditorGUILayout.Popup("Trail handles", Mathf.Clamp(activeTrail, 0, names.Length - 1), names);
                }
                if (handleGroup == 1 && authoring.Recipe.ForestRegions != null && authoring.Recipe.ForestRegions.Count > 0)
                {
                    var names = authoring.Recipe.ForestRegions.ConvertAll(region => region != null ? region.Name : "Invalid forest").ToArray();
                    activeForest = EditorGUILayout.Popup("Forest handles", Mathf.Clamp(activeForest, 0, names.Length - 1), names);
                }
                if (handleGroup == 2 && authoring.Recipe.WaterRegions != null && authoring.Recipe.WaterRegions.Count > 0)
                {
                    var names = authoring.Recipe.WaterRegions.ConvertAll(region => region != null ? region.Name : "Invalid water").ToArray();
                    activeWater = EditorGUILayout.Popup("Water handles", Mathf.Clamp(activeWater, 0, names.Length - 1), names);
                }
                EditorGUILayout.HelpBox("Bake Layer Paint заменяет покраску всех четырёх слоёв; ручные мазки Terrain будут заменены. Bake Relief заменяет ручную скульптуру высот. Сначала можно сохранить копию данных. Оба действия поддерживают Undo.", MessageType.Warning);
                if (GUILayout.Button("Save Ground Snapshot")) Snapshot(authoring);
                if (GUILayout.Button("Bake Layer Paint (replace painting)")) Bake(authoring, false, true);
                if (GUILayout.Button("Bake Relief (replace sculpting)")) Bake(authoring, true, false);
                if (ForestBlockoutEnvironment.CanRebuildContours(authoring))
                {
                    EditorGUILayout.HelpBox("После изменения Forest Regions нажми Rebuild Forest Contours: обновятся линии и препятствия леса. Деревья, берег, покраска и рельеф сохраняются. Bake Layer Paint выполняется отдельно; после обновления сохрани сцену.", MessageType.Info);
                    if (GUILayout.Button("Rebuild Forest Contours (keep manual trees)"))
                        ForestBlockoutEnvironment.RebuildContours(authoring);
                }
                if (GUILayout.Button("Select Terrain Paint Tools")) Selection.activeObject = authoring.Surface;
            }
        }

        private static void Snapshot(GroundAuthoring authoring)
        {
            // CopyAsset copies persisted data. Include unsaved brush strokes and handle edits.
            AssetDatabase.SaveAssets();
            string terrainPath = AssetDatabase.GetAssetPath(authoring.Surface.terrainData);
            string recipePath = AssetDatabase.GetAssetPath(authoring.Recipe);
            string folder = AssetDatabase.GenerateUniqueAssetPath("Assets/_Project/GroundSnapshots/Snapshot");
            GroundSceneUpgrade.EnsureFolder(folder);
            if (!AssetDatabase.CopyAsset(terrainPath, folder + "/Terrain.asset") ||
                !AssetDatabase.CopyAsset(recipePath, folder + "/Recipe.asset"))
                throw new System.IO.IOException("Не удалось сохранить копию земли.");
            Debug.Log("Копия рельефа/покраски и параметров: " + folder);
        }

        private static void Bake(GroundAuthoring authoring, bool heights, bool paint)
        {
            GroundTerrainBaker.Bake(authoring.Surface, authoring.Recipe, heights, paint);
            EditorUtility.SetDirty(authoring.Surface.terrainData);
            AssetDatabase.SaveAssets();
            EditorSceneManager.MarkSceneDirty(authoring.gameObject.scene);
            SceneView.RepaintAll();
        }

        private void OnSceneGUI()
        {
            var authoring = (GroundAuthoring)target;
            GroundRecipe recipe = authoring.Recipe;
            if (EditorApplication.isPlayingOrWillChangePlaymode || recipe == null) return;

            // Draw all masses while handles edit only the chosen outline. Forest contours
            // remain usable when a recipe has no trails yet.
            if (recipe.ForestRegions != null)
            {
                activeForest = Mathf.Clamp(activeForest, 0, recipe.ForestRegions.Count - 1);
                for (int i = 0; i < recipe.ForestRegions.Count; i++)
                {
                    GroundForestRegion region = recipe.ForestRegions[i];
                    if (region == null) continue;
                    bool editable = handleGroup == 1 && i == activeForest;
                    Handles.color = editable ? new Color(.30f, .94f, .46f) : new Color(.25f, .65f, .35f, .6f);
                    DrawPolygon(authoring, recipe, region.Name, region.Points, editable, "Move forest vertex");
                }
            }
            if (recipe.WaterRegions != null)
            {
                activeWater = Mathf.Clamp(activeWater, 0, recipe.WaterRegions.Count - 1);
                for (int i = 0; i < recipe.WaterRegions.Count; i++)
                {
                    GroundWaterRegion region = recipe.WaterRegions[i];
                    if (region == null) continue;
                    bool editable = handleGroup == 2 && i == activeWater;
                    Handles.color = editable ? new Color(.35f, .78f, 1f) : new Color(.25f, .6f, .9f, .55f);
                    DrawPolygon(authoring, recipe, region.Name, region.Points, editable, "Move water vertex");
                }
            }
            if (handleGroup != 0 || recipe.Trails == null || recipe.Trails.Count == 0) return;
            activeTrail = Mathf.Clamp(activeTrail, 0, recipe.Trails.Count - 1);
            GroundTrail trail = recipe.Trails[activeTrail];
            if (trail == null || trail.Points == null) return;
            Handles.color = new Color(1f, .79f, .35f);
            try
            {
                var sampler = new GroundPathMath(recipe);
                var curve = sampler.GetTrailPoints(activeTrail);
                var guide = new Vector3[curve.Count];
                for (int i = 0; i < curve.Count; i++)
                    guide[i] = new Vector3(curve[i].x, sampler.SampleHeight(curve[i]) + .08f, curve[i].y);
                Handles.DrawAAPolyLine(3f, guide);
            }
            catch (System.ArgumentException)
            {
                // Invalid in-progress Inspector edits remain editable; Bake gives the exact error.
            }
            Vector3? previous = null;
            for (int i = 0; i < trail.Points.Count; i++)
            {
                Vector3 position = GuidePosition(authoring, recipe, trail.Points[i]);
                if (previous.HasValue) Handles.DrawDottedLine(previous.Value, position, 4);
                previous = position;
                MovePoint(recipe, trail.Points, i, position, trail.Name, "Move trail point");
            }
        }

        private static void DrawPolygon(GroundAuthoring authoring, GroundRecipe recipe, string name,
            List<Vector2> points, bool editable, string undoName)
        {
            if (points == null || points.Count == 0) return;
            var outline = new Vector3[points.Count + 1];
            Vector3 labelCentre = Vector3.zero;
            for (int i = 0; i < points.Count; i++)
            {
                outline[i] = GuidePosition(authoring, recipe, points[i]);
                labelCentre += outline[i];
            }
            outline[points.Count] = outline[0];
            Handles.DrawAAPolyLine(editable ? 3f : 2f, outline);
            Handles.Label(labelCentre / points.Count + Vector3.up * .3f, name);
            if (!editable) return;
            for (int i = 0; i < points.Count; i++)
                MovePoint(recipe, points, i, outline[i], name, undoName);
        }

        private static Vector3 GuidePosition(GroundAuthoring authoring, GroundRecipe recipe, Vector2 point)
        {
            float y = authoring.Surface != null
                ? authoring.Surface.SampleHeight(new Vector3(point.x, 0, point.y)) + authoring.Surface.transform.position.y
                : recipe.BaseHeight;
            return new Vector3(point.x, y + .08f, point.y);
        }

        private static void MovePoint(GroundRecipe recipe, List<Vector2> points, int index, Vector3 position,
            string label, string undoName)
        {
            Handles.Label(position + Vector3.up * .2f, label + " · " + (index + 1));
            EditorGUI.BeginChangeCheck();
            Vector3 moved = Handles.PositionHandle(position, Quaternion.identity);
            if (!EditorGUI.EndChangeCheck()) return;
            Undo.RecordObject(recipe, undoName);
            points[index] = new Vector2(
                Mathf.Clamp(moved.x, recipe.Origin.x, recipe.Origin.x + recipe.Size.x),
                Mathf.Clamp(moved.z, recipe.Origin.z, recipe.Origin.z + recipe.Size.z));
            EditorUtility.SetDirty(recipe);
            SceneView.RepaintAll();
        }
    }
}

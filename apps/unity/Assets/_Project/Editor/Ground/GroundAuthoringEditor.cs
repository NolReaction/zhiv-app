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

        public override void OnInspectorGUI()
        {
            DrawDefaultInspector();
            var authoring = (GroundAuthoring)target;
            if (authoring.Recipe == null || authoring.Surface == null) return;
            EditorGUILayout.Space();
            EditorGUILayout.HelpBox("Точки — мировые X/Z. Width — полная ширина в метрах; Feather — мягкий край. После перемещения точек нажми Bake Layer Paint. Рельеф и ручная покраска не обновляются автоматически.", MessageType.Info);
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

                if (authoring.Recipe.Trails != null && authoring.Recipe.Trails.Count > 0)
                {
                    var names = authoring.Recipe.Trails.ConvertAll(trail => trail != null ? trail.Name : "Invalid trail").ToArray();
                    activeTrail = EditorGUILayout.Popup("Trail handles", Mathf.Clamp(activeTrail, 0, names.Length - 1), names);
                }
                EditorGUILayout.HelpBox("Bake Layer Paint заменяет покраску всех четырёх слоёв; ручные мазки Terrain будут заменены. Bake Relief заменяет ручную скульптуру высот. Сначала можно сохранить копию данных. Оба действия поддерживают Undo.", MessageType.Warning);
                if (GUILayout.Button("Save Ground Snapshot")) Snapshot(authoring);
                if (GUILayout.Button("Bake Layer Paint (replace painting)")) Bake(authoring, false, true);
                if (GUILayout.Button("Bake Relief (replace sculpting)")) Bake(authoring, true, false);
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
            if (EditorApplication.isPlayingOrWillChangePlaymode || recipe == null || recipe.Trails == null || recipe.Trails.Count == 0) return;
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
                Vector2 p = trail.Points[i];
                float y = authoring.Surface != null
                    ? authoring.Surface.SampleHeight(new Vector3(p.x, 0, p.y)) + authoring.Surface.transform.position.y
                    : recipe.BaseHeight;
                var position = new Vector3(p.x, y + .08f, p.y);
                if (previous.HasValue) Handles.DrawDottedLine(previous.Value, position, 4);
                previous = position;
                Handles.Label(position + Vector3.up * .2f, trail.Name + " · " + (i + 1));
                EditorGUI.BeginChangeCheck();
                Vector3 moved = Handles.PositionHandle(position, Quaternion.identity);
                if (!EditorGUI.EndChangeCheck()) continue;
                Undo.RecordObject(recipe, "Move trail point");
                trail.Points[i] = new Vector2(
                    Mathf.Clamp(moved.x, recipe.Origin.x, recipe.Origin.x + recipe.Size.x),
                    Mathf.Clamp(moved.z, recipe.Origin.z, recipe.Origin.z + recipe.Size.z));
                EditorUtility.SetDirty(recipe);
            }
        }
    }
}

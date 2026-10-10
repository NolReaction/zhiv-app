using UnityEditor;
using UnityEngine;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    [CustomEditor(typeof(ForestLandmark))]
    public sealed class ForestLandmarkEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            DrawDefaultInspector();
            EditorGUILayout.HelpBox("Arrival — свободная точка подхода для проверки маршрута. " +
                "После перемещения места подгони дорожку и Pad в Ground Authoring. " +
                "Рельеф и лес не перестраиваются автоматически.", MessageType.Info);
            var landmark = (ForestLandmark)target;
            using (new EditorGUI.DisabledScope(landmark.Arrival == null))
                if (GUILayout.Button("Select Arrival"))
                {
                    Selection.activeTransform = landmark.Arrival;
                    SceneView.lastActiveSceneView?.FrameSelected();
                }
        }

        [DrawGizmo(GizmoType.Selected | GizmoType.NonSelected)]
        private static void DrawPlaceLabel(ForestLandmark landmark, GizmoType gizmoType)
        {
            if (landmark == null || !landmark.isActiveAndEnabled) return;
            Handles.Label(landmark.transform.position + Vector3.up * 3,
                landmark.DisplayName + " [" + landmark.Id + "]");
        }
    }
}

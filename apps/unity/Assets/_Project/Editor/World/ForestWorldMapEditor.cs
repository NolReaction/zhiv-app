using UnityEditor;
using UnityEngine;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    [CustomEditor(typeof(ForestWorldMap))]
    public sealed class ForestWorldMapEditor : UnityEditor.Editor
    {
        public override void OnInspectorGUI()
        {
            var map = (ForestWorldMap)target;
            string path = map.gameObject.scene.path;
            bool blockout = map.IsBlockout && path == ExpandedForestSceneBuilder.BlockoutScenePath;
            EditorGUILayout.LabelField("Сцена", map.gameObject.scene.name, EditorStyles.boldLabel);
            EditorGUILayout.LabelField("Планировка", blockout ? "Лесные контуры" : "Прежняя или другая сцена");
            if (blockout)
                EditorGUILayout.HelpBox("Открыта ForestBlockout: лес задаётся контурами, деревья служат редкими акцентами. " +
                    "Контуры редактируются в рецепте земли через Ground Surface.", MessageType.Info);
            else if (path == ForestLayoutSceneBuilder.ScenePath)
                EditorGUILayout.HelpBox("Открыта прежняя ForestLayout с плотным лесом. Планировка с контурами — " +
                    "отдельная ForestBlockout. Кнопка ниже откроет её, не заменяя эту сцену.", MessageType.Info);
            else
                EditorGUILayout.HelpBox("Эта сцена не отмечена как ForestBlockout. Кнопка ниже открывает " +
                    "отдельную планировку с контурами и не перестраивает существующие сцены.", MessageType.Info);

            using (new EditorGUI.DisabledScope(EditorApplication.isPlayingOrWillChangePlaymode ||
                EditorApplication.isCompiling || EditorApplication.isUpdating))
                if (GUILayout.Button("Открыть планировку с контурами"))
                {
                    ExpandedForestSceneBuilder.CreateOrOpenBlockout();
                    GUIUtility.ExitGUI();
                }
            if (EditorApplication.isCompiling)
                EditorGUILayout.HelpBox("Дождись завершения компиляции Unity, затем открой планировку.", MessageType.Info);

            EditorGUILayout.Space();
            serializedObject.Update();
            SerializedProperty property = serializedObject.GetIterator();
            bool enterChildren = true;
            while (property.NextVisible(enterChildren))
            {
                enterChildren = false;
                using (new EditorGUI.DisabledScope(property.name == "m_Script" || property.name == "IsBlockout"))
                    EditorGUILayout.PropertyField(property, true);
            }
            serializedObject.ApplyModifiedProperties();
        }
    }
}

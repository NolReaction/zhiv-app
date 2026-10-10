using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Read-only investigation of loaded objects and existing serialized script references.</summary>
    public static class MissingScriptDiagnostics
    {
        private const int DetailLimit = 50;
        private static readonly Regex ScriptReference = new Regex(@"\bm_Script:\s*\{(?<body>[^}]*)\}");
        private static readonly Regex GuidReference = new Regex(@"guid:\s*(?<guid>[a-fA-F0-9]{32})");
        private static readonly Regex FileIdentifier = new Regex(@"fileID:\s*(?<id>-?\d+)");

        [MenuItem("Zhiv/Diagnose Missing Scripts", priority = 21)]
        public static void Diagnose()
        {
            if (!CanDiagnose()) return;
            Debug.Log("[MissingScripts] Только диагностика: компоненты и файлы не удаляются, сцены не сохраняются, " +
                "импорт не запускается. Сохранённый YAML может отличаться от несохранённых изменений.");
            var files = new HashSet<string>(StringComparer.Ordinal);
            var seen = new HashSet<int>();
            int scenes = 0, dirtyScenes = 0, objects = 0, components = 0, objectDetails = 0;
            for (int index = 0; index < SceneManager.sceneCount; index++)
            {
                Scene scene = SceneManager.GetSceneAt(index);
                if (!scene.isLoaded || EditorSceneManager.IsPreviewScene(scene)) continue;
                scenes++;
                if (scene.isDirty) dirtyScenes++;
                if (!string.IsNullOrEmpty(scene.path)) files.Add(scene.path);
                foreach (GameObject root in scene.GetRootGameObjects())
                foreach (Transform part in root.GetComponentsInChildren<Transform>(true))
                {
                    GameObject go = part.gameObject;
                    seen.Add(go.GetInstanceID());
                    string prefab = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(go);
                    if (IsPrefab(prefab)) files.Add(prefab);
                    int missing = GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(go);
                    if (missing == 0) continue;
                    objects++;
                    components += missing;
                    if (objectDetails++ >= DetailLimit) continue;
                    LogObject(go, "loaded scene", missing, prefab);
                }
            }

            int extraObjects = 0, extraComponents = 0;
            // Include already loaded asset previews and editor/stage objects without loading prefabs.
            foreach (GameObject go in Resources.FindObjectsOfTypeAll<GameObject>())
            {
                if (go == null || !seen.Add(go.GetInstanceID())) continue;
                int missing = GameObjectUtility.GetMonoBehavioursWithMissingScriptCount(go);
                if (missing == 0) continue;
                extraObjects++;
                extraComponents += missing;
                string asset = AssetDatabase.GetAssetPath(go);
                if (IsPrefab(asset)) files.Add(asset);
                string prefab = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(go);
                if (IsPrefab(prefab)) files.Add(prefab);
                if (objectDetails++ < DetailLimit)
                    LogObject(go, "asset/editor object" + (string.IsNullOrEmpty(asset) ? "" : " " + asset), missing, prefab);
            }

            string selected = AssetDatabase.GetAssetPath(Selection.activeObject);
            if (IsPrefab(selected)) files.Add(selected);
            if (files.Count > 0)
            {
                var roots = new string[files.Count];
                files.CopyTo(roots);
                foreach (string dependency in AssetDatabase.GetDependencies(roots, true))
                    if (IsPrefab(dependency)) files.Add(dependency);
            }

            var references = new HashSet<string>(StringComparer.Ordinal);
            var report = new SavedReport();
            foreach (string file in files) ScanSavedFile(file, references, report);
            Debug.Log("[MissingScripts] Итог: открытых сцен " + scenes + " (с изменениями " + dirtyScenes +
                "); объектов с Missing Script " + objects + "; компонентов " + components +
                "; вне обычных сцен объектов " + extraObjects + "/компонентов " + extraComponents +
                "; прочитано YAML-файлов " + report.Files + "; уникальных отсутствующих GUID-ссылок " + report.Unresolved +
                "; пустых m_Script " + report.Empty + "; незагруженных классов C# " + report.Unloaded +
                "; пропущенных файлов " + report.Skipped + ". Показано до 50 объектов и 50 записей YAML. " +
                "DLL/subasset class fileID здесь не проверяются; GetClass=null сам по себе не доказывает потерю скрипта. " +
                "Нулевой итог не проверяет ещё не загруженные ассеты или EditorWindow. " +
                "Для точного исправления нужны первые записи Object и YAML из этого отчёта.");
        }

        [MenuItem("Zhiv/Diagnose Missing Scripts", true)]
        private static bool CanDiagnose()
        {
            return !EditorApplication.isCompiling && !EditorApplication.isUpdating &&
                !EditorApplication.isPlayingOrWillChangePlaymode;
        }

        private static void ScanSavedFile(string assetPath, HashSet<string> references, SavedReport report)
        {
            string projectRoot = Path.GetDirectoryName(Application.dataPath);
            string absolute = Path.Combine(projectRoot, assetPath);
            if (!File.Exists(absolute)) { report.Skipped++; return; }
            try
            {
                using (var reader = new StreamReader(absolute, Encoding.UTF8, true))
                {
                    string line = reader.ReadLine();
                    if (line == null || !line.StartsWith("%YAML", StringComparison.Ordinal))
                    { report.Skipped++; return; }
                    report.Files++;
                    string owner = "unknown";
                    int lineNumber = 1;
                    while ((line = reader.ReadLine()) != null)
                    {
                        lineNumber++;
                        if (line.StartsWith("--- !u!", StringComparison.Ordinal)) owner = line;
                        Match script = ScriptReference.Match(line);
                        if (!script.Success) continue;
                        string body = script.Groups["body"].Value;
                        string guid = GuidReference.Match(body).Groups["guid"].Value.ToLowerInvariant();
                        string fileId = FileIdentifier.Match(body).Groups["id"].Value;
                        if (!references.Add(assetPath + "|" + guid + "|" + fileId)) continue;
                        string resolved = string.IsNullOrEmpty(guid) ? "" : AssetDatabase.GUIDToAssetPath(guid);
                        string reason;
                        if (string.IsNullOrEmpty(guid))
                        { report.Empty++; reason = "пустая ссылка m_Script; GUID не записан"; }
                        else if (string.IsNullOrEmpty(resolved))
                        { report.Unresolved++; reason = "GUID не найден в AssetDatabase"; }
                        else if (resolved.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                        {
                            MonoScript mono = AssetDatabase.LoadAssetAtPath<MonoScript>(resolved);
                            if (mono != null && mono.GetClass() != null) continue;
                            report.Unloaded++;
                            reason = "GUID найден, но класс C# не загружен: " + resolved +
                                "; проверь первую ошибку компиляции/импорт. Это диагностический признак, не основание для удаления";
                        }
                        else continue;
                        if (report.Details++ < DetailLimit)
                            Debug.LogWarning("[MissingScripts] YAML: " + assetPath + ":" + lineNumber +
                                " | serialized object: " + owner + " | script fileID: " + fileId +
                                " | GUID: " + (string.IsNullOrEmpty(guid) ? "нет" : guid) + " | " + reason);
                    }
                }
            }
            catch (Exception exception)
            {
                report.Skipped++;
                if (report.Details++ < DetailLimit)
                    Debug.LogWarning("[MissingScripts] Не удалось прочитать " + assetPath + ": " + exception.Message);
            }
        }

        private static bool IsPrefab(string path) => !string.IsNullOrEmpty(path) &&
            path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase);

        private static void LogObject(GameObject go, string scope, int missing, string prefab)
        {
            var indices = new List<string>();
            Component[] slots = go.GetComponents<Component>();
            for (int slot = 0; slot < slots.Length; slot++) if (slots[slot] == null) indices.Add(slot.ToString());
            Scene scene = go.scene;
            string scenePath = scene.IsValid() ? (string.IsNullOrEmpty(scene.path) ? scene.name + " (не сохранена)" : scene.path) : "нет";
            Debug.LogWarning("[MissingScripts] Object: " + HierarchyPath(go.transform) + " | scope: " + scope +
                " | scene: " + scenePath + " | missing: " + missing + " | component indices (с 0): " + string.Join(", ", indices) +
                " | prefab source: " + (string.IsNullOrEmpty(prefab) ? "нет" : prefab), go);
        }

        private static string HierarchyPath(Transform part)
        {
            string path = part.name;
            for (Transform parent = part.parent; parent != null; parent = parent.parent) path = parent.name + "/" + path;
            return path;
        }

        private sealed class SavedReport
        {
            public int Files, Skipped, Unresolved, Empty, Unloaded, Details;
        }
    }
}

using System;
using System.IO;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;

namespace Zhiv.UnityPrototype.Editor
{
    public static class PrototypeBuild
    {
        [MenuItem("Zhiv/Build Web Prototype", priority = 20)]
        public static void Web()
        {
            Build(PrototypeSceneBuilder.ScenePath, "Builds/Web");
        }

        [MenuItem("Zhiv/Build Forest Layout Web", priority = 21)]
        public static void ForestWeb()
        {
            Build(ForestLayoutSceneBuilder.ScenePath, "Builds/ForestWeb");
        }

        [MenuItem("Zhiv/Build Forest Blockout Web", priority = 22)]
        public static void ForestBlockoutWeb()
        {
            Build(ExpandedForestSceneBuilder.BlockoutScenePath, "Builds/ForestBlockoutWeb");
        }

        private static void Build(string scenePath, string outputPath)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode)
                throw new InvalidOperationException("Сначала останови Play Mode.");
            if (!File.Exists(scenePath))
                throw new InvalidOperationException("Сначала создай сцену через меню Zhiv: " + scenePath);
            if (!BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.WebGL, BuildTarget.WebGL))
                throw new InvalidOperationException("Добавь Web Build Support для этого Editor через Unity Hub.");
            if (!UnityEditor.SceneManagement.EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            AssetDatabase.SaveAssets();
            // A separate local output; no upload or deployment.
            var options = new BuildPlayerOptions
            {
                scenes = new[] { scenePath },
                locationPathName = outputPath,
                target = BuildTarget.WebGL,
                options = BuildOptions.Development
            };
            BuildReport report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result != BuildResult.Succeeded)
                throw new BuildFailedException("Web build: " + report.summary.result);
            UnityEngine.Debug.Log("Web-прототип: " + outputPath + ". Для проверки нужен HTTP-сервер, не file://.");
        }
    }
}

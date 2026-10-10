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
            if (!File.Exists(PrototypeSceneBuilder.ScenePath))
                throw new InvalidOperationException("Сначала выполни Zhiv/Create or Open 3D Clearing.");
            if (!BuildPipeline.IsBuildTargetSupported(BuildTargetGroup.WebGL, BuildTarget.WebGL))
                throw new InvalidOperationException("Добавь Web Build Support для этого Editor через Unity Hub.");
            if (!UnityEditor.SceneManagement.EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
            // A separate local output; no upload or deployment.
            var options = new BuildPlayerOptions
            {
                scenes = new[] { PrototypeSceneBuilder.ScenePath },
                locationPathName = "Builds/Web",
                target = BuildTarget.WebGL,
                options = BuildOptions.Development
            };
            BuildReport report = BuildPipeline.BuildPlayer(options);
            if (report.summary.result != BuildResult.Succeeded)
                throw new BuildFailedException("Web build: " + report.summary.result);
            UnityEngine.Debug.Log("Web-прототип: Builds/Web. Для проверки нужен HTTP-сервер, не file://.");
        }
    }
}

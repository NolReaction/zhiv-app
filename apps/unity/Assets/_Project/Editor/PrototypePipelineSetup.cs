using System;
using UnityEditor;
using UnityEditor.Rendering;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Called by the explicit scene creation command, never during import.</summary>
    public static class PrototypePipelineSetup
    {
        public static void Configure(string generatedFolder)
        {
            if (string.IsNullOrWhiteSpace(generatedFolder) ||
                !generatedFolder.StartsWith("Assets/", StringComparison.Ordinal) ||
                !AssetDatabase.IsValidFolder(generatedFolder))
            {
                throw new ArgumentException("Create an Assets subfolder before configuring URP.", nameof(generatedFolder));
            }

            string rendererPath = generatedFolder + "/ClearingRenderer.asset";
            string pipelinePath = generatedFolder + "/ClearingPipeline.asset";
            if (AssetDatabase.LoadMainAssetAtPath(rendererPath) != null ||
                AssetDatabase.LoadMainAssetAtPath(pipelinePath) != null)
            {
                throw new InvalidOperationException("Rendering assets already exist; choose a new generated folder.");
            }

            var renderer = ScriptableObject.CreateInstance<UniversalRendererData>();
            renderer.name = "ClearingRenderer";
            renderer.renderingMode = RenderingMode.Forward;
            renderer.postProcessData = AssetDatabase.LoadAssetAtPath<PostProcessData>(
                UniversalRenderPipelineAsset.packagePath + "/Runtime/Data/PostProcessData.asset");
            if (renderer.postProcessData == null)
            {
                UnityEngine.Object.DestroyImmediate(renderer);
                throw new InvalidOperationException("URP resources are unavailable. Wait for Package Manager to finish importing URP 17.3.0.");
            }

            AssetDatabase.CreateAsset(renderer, rendererPath);
            ResourceReloader.ReloadAllNullIn(renderer, UniversalRenderPipelineAsset.packagePath);

            var pipeline = UniversalRenderPipelineAsset.Create(renderer);
            pipeline.name = "ClearingPipeline";
            pipeline.supportsHDR = false;
            pipeline.msaaSampleCount = 4;
            pipeline.renderScale = 1f;
            pipeline.shadowDistance = 65f;
            pipeline.shadowCascadeCount = 2;
            pipeline.mainLightShadowmapResolution = 2048;
            pipeline.shadowDepthBias = 0.8f;
            pipeline.shadowNormalBias = 0.6f;
            pipeline.maxAdditionalLightsCount = 4;
            pipeline.supportsCameraDepthTexture = false;
            pipeline.supportsCameraOpaqueTexture = false;

            // URP 17.3 exposes only an internal setter for this Inspector setting.
            // The serialized field is verified against the pinned package source.
            var pipelineSettings = new SerializedObject(pipeline);
            var softShadows = pipelineSettings.FindProperty("m_SoftShadowsSupported");
            if (softShadows == null)
            {
                UnityEngine.Object.DestroyImmediate(pipeline);
                throw new InvalidOperationException("URP shadow settings changed; use the project's pinned URP version.");
            }
            softShadows.boolValue = true;
            pipelineSettings.ApplyModifiedPropertiesWithoutUndo();
            AssetDatabase.CreateAsset(pipeline, pipelinePath);

            // Unity creates and populates URP Global Settings through the pipeline's
            // EnsureGlobalSettings on initialization. Do not create a bare settings
            // ScriptableObject: its shader/resource containers would be missing.
            GraphicsSettings.defaultRenderPipeline = pipeline;
            int initialQuality = QualitySettings.GetQualityLevel();
            try
            {
                for (int index = 0; index < QualitySettings.names.Length; index++)
                {
                    QualitySettings.SetQualityLevel(index, false);
                    QualitySettings.renderPipeline = pipeline;
                }
            }
            finally
            {
                QualitySettings.SetQualityLevel(initialQuality, false);
            }

            PlayerSettings.companyName = "Zhiv";
            PlayerSettings.productName = "Zhiv World Prototype";
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.defaultInterfaceOrientation = UIOrientation.Portrait;
            PlayerSettings.allowedAutorotateToPortrait = true;
            PlayerSettings.allowedAutorotateToPortraitUpsideDown = false;
            PlayerSettings.allowedAutorotateToLandscapeLeft = false;
            PlayerSettings.allowedAutorotateToLandscapeRight = false;
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Gzip;
            PlayerSettings.WebGL.decompressionFallback = true;
            EditorSettings.serializationMode = SerializationMode.ForceText;
            EditorUtility.SetDirty(renderer);
            EditorUtility.SetDirty(pipeline);
            AssetDatabase.SaveAssets();
        }
    }
}

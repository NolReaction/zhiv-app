using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    public sealed class ExpandedForestZone
    {
        public readonly string Id;
        public readonly string DisplayName;
        public readonly Vector2 MapCenter;
        public readonly Vector2 MapEntrance;
        public readonly Vector2 Center;
        public readonly Vector2 Entrance;
        public readonly Vector2 Footprint;
        public readonly float ClearanceRadius;
        public readonly bool Future;
        public readonly bool Reachable;

        public ExpandedForestZone(string id, string displayName, Vector2 mapCenter,
            float clearanceRadius, bool future = false, Vector2? footprint = null)
        {
            Id = id;
            DisplayName = displayName;
            MapCenter = mapCenter;
            Center = ExpandedForestDefinition.ToWorldXZ(mapCenter);
            // Existing prototype buildings face world -Z. Compact utility sites need
            // proportionate approaches rather than an eight-metre building reservation.
            Footprint = footprint ?? new Vector2(8, 8);
            Entrance = Center + new Vector2(0, -(Footprint.y * .5f + 1.5f));
            MapEntrance = ExpandedForestDefinition.ToMapXZ(Entrance);
            ClearanceRadius = clearanceRadius;
            Future = future;
            Reachable = true;
        }
    }

    /// <summary>One-time composition seed; all generated Terrain and scene assets remain editable.</summary>
    public static class ExpandedForestDefinition
    {
        private const float InverseSqrtTwo = .70710678118f;
        public const float WaterHeight = -.25f;
        public static readonly Vector3 TerrainOrigin = new Vector3(-140, -3, -140);
        public static readonly Vector3 TerrainSize = new Vector3(280, 6, 280);
        public static readonly Rect PlayableMapBounds = new Rect(-64, -72, 128, 144);

        public static readonly ExpandedForestZone Home = Zone("home", "01 · Дом Мохлика", -22, -6, 12);
        public static readonly ExpandedForestZone Workshop = Zone("workshop", "02 · Мастерская", -35, 24, 10);
        public static readonly ExpandedForestZone Garden = Zone("garden", "03 · Лесной сад", -48, 53, 9);
        public static readonly ExpandedForestZone Quarry = Zone("quarry", "04 · Каменоломня", -6, 48, 12);
        public static readonly ExpandedForestZone UpperPass = Zone("upper-pass", "05 · Северный проход", 35, 48, 10);
        public static readonly ExpandedForestZone EastClearing = Zone("east-clearing", "06 · Восточная поляна", 43, 15, 11);
        public static readonly ExpandedForestZone Camp = Zone("camp", "07 · Лагерь", 5, 14, 11);
        public static readonly ExpandedForestZone Warehouse = Zone("warehouse", "08 · Кладовая", -22, -34, 10);
        public static readonly ExpandedForestZone Market = Zone("market", "09 · Рынок и причал", 20, -37, 9);
        public static readonly ExpandedForestZone Fishing = Zone("fishing", "10 · Рыбацкий берег", 51, -8, 8);
        public static readonly ExpandedForestZone Lighthouse = Zone("lighthouse", "11 · Маяк", 46, -59, 9);
        public static readonly ExpandedForestZone FutureWest = Zone("future-west", "12 · Запас: западная поляна", -46, -54, 10, true);
        public static readonly ExpandedForestZone FutureNorth = Zone("future-north", "13 · Запас: северный лес", 9, 63, 9, true);
        private static readonly ExpandedForestZone[] ZoneValues =
        {
            Home, Workshop, Garden, Quarry, UpperPass, EastClearing, Camp,
            Warehouse, Market, Fishing, Lighthouse, FutureWest, FutureNorth
        };
        public static IReadOnlyList<ExpandedForestZone> Zones => ZoneValues;

        /// <summary>U is right and V is up in the fixed camera composition. World axes stay unrotated.</summary>
        public static Vector2 ToWorldXZ(Vector2 map) =>
            new Vector2((map.x + map.y) * InverseSqrtTwo, (map.y - map.x) * InverseSqrtTwo);

        public static Vector2 ToMapXZ(Vector2 world) =>
            new Vector2((world.x - world.y) * InverseSqrtTwo, (world.x + world.y) * InverseSqrtTwo);

        public static Vector3 ToWorld(Vector2 map, float height = 0)
        {
            Vector2 world = ToWorldXZ(map);
            return new Vector3(world.x, height, world.y);
        }

        public static bool InClearing(Vector2 world, float margin = 0)
        {
            foreach (ExpandedForestZone zone in ZoneValues)
                if ((world - zone.Center).sqrMagnitude <
                    (zone.ClearanceRadius + margin) * (zone.ClearanceRadius + margin)) return true;
            return false;
        }

        public static GroundRecipe Create(string assetFolder)
        {
            if (string.IsNullOrWhiteSpace(assetFolder) || !AssetDatabase.IsValidFolder(assetFolder))
                throw new ArgumentException("Create an Assets folder for the expanded forest first.", nameof(assetFolder));
            GroundRecipe recipe = CreateTransient();
            string path = AssetDatabase.GenerateUniqueAssetPath(assetFolder + "/ExpandedForestGroundRecipe.asset");
            AssetDatabase.CreateAsset(recipe, path);
            AssetDatabase.SaveAssets();
            // Return the persistent asset, never rely on a pre-import ScriptableObject wrapper.
            GroundRecipe saved = AssetDatabase.LoadAssetAtPath<GroundRecipe>(path);
            if (saved == null)
                throw new InvalidOperationException("Не удалось загрузить сохранённый рецепт большой карты: " + path);
            GroundPathMath.ValidateRecipe(saved);
            return saved;
        }

        public static GroundRecipe CreateTransient()
        {
            var recipe = ScriptableObject.CreateInstance<GroundRecipe>();
            recipe.name = "Expanded Forest Ground";
            recipe.Origin = TerrainOrigin;
            recipe.Size = TerrainSize;
            recipe.Seed = 681013;
            recipe.Relief = .22f;
            recipe.PathDepression = .025f;

            Trail(recipe, "Home / workshop", 2.2f, Home, Workshop,
                P(-24, -15), P(-39, -10), P(-44, 2), P(-42, 14));
            Trail(recipe, "Workshop / quarry", 2f, Workshop, Quarry,
                P(-26, 18), P(-21, 28), P(-16, 36));
            Trail(recipe, "Workshop / garden", 1.8f, Workshop, Garden,
                P(-39, 15), P(-50, 24), P(-53, 35));
            Trail(recipe, "Quarry / northern pass", 2f, Quarry, UpperPass,
                P(3, 36), P(17, 37), P(29, 39));
            Trail(recipe, "Quarry / future north", 1.65f, Quarry, FutureNorth,
                P(4, 40), P(16, 46), P(21, 53));
            Trail(recipe, "Home / camp", 2.2f, Home, Camp,
                P(-8, -10), P(4, -1), P(13, 6));
            Trail(recipe, "Camp / eastern clearing", 2f, Camp, EastClearing,
                P(19, 7), P(30, 7), P(38, 3), P(47, 5));
            Trail(recipe, "Eastern clearing / northern pass", 1.8f, EastClearing, UpperPass,
                P(54, 21), P(51, 32), P(44, 37));
            Trail(recipe, "Eastern clearing / fishing shore", 1.7f, EastClearing, Fishing,
                P(49, 4), P(43, -1), P(43, -9), P(49, -15), P(54, -14));
            Trail(recipe, "Home / warehouse", 2.2f, Home, Warehouse,
                P(-24, -16), P(-31, -23), P(-34, -29), P(-33, -38), P(-25, -43), P(-19, -42));
            Trail(recipe, "Warehouse / future west", 1.8f, Warehouse, FutureWest,
                P(-19, -45), P(-25, -45), P(-31, -44), P(-37, -52));
            Trail(recipe, "Camp / market peninsula", 2.2f, Camp, Market,
                P(9, 0), P(11, -12), P(17, -22), P(13, -30), P(12, -39), P(16, -44), P(23, -44));
            Trail(recipe, "Market / lighthouse headland", 1.8f, Market, Lighthouse,
                P(20, -47), P(27, -54), P(33, -61), P(38, -67), P(47, -68));

            foreach (ExpandedForestZone zone in ZoneValues)
                recipe.Pads.Add(new GroundPad
                {
                    Name = zone.DisplayName + " foundation", Center = zone.Center,
                    Size = zone.Footprint, Height = 0, Feather = 2.2f
                });

            // One continuous body reaches the far boundary. The narrow western inlet and the
            // indented east coast leave an accessible market peninsula and lighthouse headland.
            var water = new GroundWaterRegion
            {
                Name = "Sea and western river arm", WaterHeight = WaterHeight,
                BedHeight = -1.6f, BankFeather = 2.8f
            };
            Vector2[] coast =
            {
                P(90, 6), P(68, 3), P(65, -8), P(57, -16), P(47, -20), P(43, -27),
                P(38, -29), P(31, -29), P(28, -34), P(29, -40), P(34, -44), P(41, -43),
                P(49, -42), P(55, -46), P(60, -50), P(61, -57), P(60, -64), P(57, -69),
                P(50, -73), P(39, -74), P(29, -72), P(21, -67), P(17, -60), P(16, -52),
                P(13, -49), P(9, -47), P(5, -39), P(1, -31), P(-4, -27), P(-7, -25),
                P(-10, -25), P(-8, -30), P(-5, -36), P(-1, -43), P(3, -51), P(7, -57),
                P(11, -60), P(13, -69), P(17, -76), P(25, -82), P(32, -86), P(35, -100),
                // Extend beyond the physical Terrain so its southern edge never grows a false bank.
                P(0, -225), P(225, 0), P(140, 18), P(100, 15)
            };
            foreach (Vector2 point in coast) water.Points.Add(ToWorldXZ(point));
            recipe.WaterRegions.Add(water);
            GroundPathMath.ValidateRecipe(recipe);
            return recipe;
        }

        private static ExpandedForestZone Zone(string id, string displayName, float u, float v,
            float radius, bool future = false) => new ExpandedForestZone(id, displayName, P(u, v), radius, future);

        private static Vector2 P(float u, float v) => new Vector2(u, v);

        private static void Trail(GroundRecipe recipe, string name, float width,
            ExpandedForestZone from, ExpandedForestZone to, params Vector2[] mapPoints)
        {
            // These approach points keep paths in front of model footprints at both endpoints.
            var points = new List<Vector2> { from.Entrance, from.Entrance + new Vector2(0, -2) };
            foreach (Vector2 point in mapPoints) points.Add(ToWorldXZ(point));
            points.Add(to.Entrance + new Vector2(0, -2));
            points.Add(to.Entrance);
            recipe.Trails.Add(new GroundTrail { Name = name, Width = width, Feather = .9f, Points = points });
        }
    }
}

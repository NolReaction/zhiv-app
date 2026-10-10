using System;
using System.Collections.Generic;
using UnityEngine;
using Zhiv.WorldPrototype;

namespace Zhiv.UnityPrototype.Editor
{
    /// <summary>Deterministic field sampler. No asset writes or global random state.</summary>
    public sealed class GroundPathMath
    {
        private const float BinSize = 2f;
        private const float CurveStep = .2f;
        private readonly GroundRecipe recipe;
        private readonly List<Segment> segments = new List<Segment>();
        private readonly List<List<Vector2>> trailCurves = new List<List<Vector2>>();
        private readonly Dictionary<Vector2Int, List<int>> bins = new Dictionary<Vector2Int, List<int>>();
        private readonly List<WaterArea> waterAreas = new List<WaterArea>();
        private readonly List<ForestArea> forestAreas = new List<ForestArea>();
        private readonly Vector2 noiseOffset;

        private sealed class WaterArea
        {
            public GroundWaterRegion Region;
            public Vector2 Min;
            public Vector2 Max;
        }

        private sealed class ForestArea
        {
            public GroundForestRegion Region;
            public Vector2 Min;
            public Vector2 Max;
        }

        private struct Segment
        {
            public Vector2 A;
            public Vector2 Delta;
            public float InverseLengthSquared;
            public float Radius;
            public float Feather;
        }

        public GroundPathMath(GroundRecipe recipe)
        {
            ValidateRecipe(recipe);
            this.recipe = recipe;
            var random = new System.Random(recipe.Seed);
            noiseOffset = new Vector2((float)random.NextDouble() * 800f + 100f,
                (float)random.NextDouble() * 800f + 100f);
            foreach (GroundTrail trail in recipe.Trails) AddTrail(trail);
            if (recipe.WaterRegions != null)
                foreach (GroundWaterRegion region in recipe.WaterRegions)
                {
                    Vector2 min = region.Points[0];
                    Vector2 max = min;
                    foreach (Vector2 point in region.Points)
                    {
                        min = Vector2.Min(min, point);
                        max = Vector2.Max(max, point);
                    }
                    waterAreas.Add(new WaterArea { Region = region, Min = min, Max = max });
                }
            if (recipe.ForestRegions != null)
                foreach (GroundForestRegion region in recipe.ForestRegions)
                {
                    Vector2 min = region.Points[0];
                    Vector2 max = min;
                    foreach (Vector2 point in region.Points)
                    {
                        min = Vector2.Min(min, point);
                        max = Vector2.Max(max, point);
                    }
                    forestAreas.Add(new ForestArea { Region = region, Min = min, Max = max });
                }
        }

        public static void ValidateRecipe(GroundRecipe recipe)
        {
            if (recipe == null) throw new ArgumentNullException(nameof(recipe));
            RequireFinite(recipe.Origin, "Origin");
            RequireFinite(recipe.Size, "Size");
            if (recipe.Size.x < 1f || recipe.Size.z < 1f || recipe.Size.y <= 0f ||
                recipe.Size.x > 512f || recipe.Size.z > 512f)
                throw new ArgumentException("Ground size must have X/Z in 1..512 metres and a positive Y height range.");
            RequireFinite(recipe.BaseHeight, "BaseHeight");
            RequireFinite(recipe.Relief, "Relief");
            RequireFinite(recipe.PathDepression, "PathDepression");
            if (recipe.Relief < 0f || recipe.PathDepression < 0f)
                throw new ArgumentException("Relief and PathDepression must not be negative.");
            float bottom = recipe.Origin.y;
            float top = bottom + recipe.Size.y;
            RequireFinite(top, "Terrain top");
            RequireFinite(recipe.Origin.x + recipe.Size.x, "Terrain east edge");
            RequireFinite(recipe.Origin.z + recipe.Size.z, "Terrain north edge");
            if (recipe.BaseHeight - recipe.Relief - recipe.PathDepression < bottom ||
                recipe.BaseHeight + recipe.Relief > top)
                throw new ArgumentException("Base height, relief and path depression must fit inside the Terrain Y range.");
            if (recipe.Trails == null || recipe.Pads == null)
                throw new ArgumentException("Trails and Pads lists must not be null.");
            if (recipe.Trails.Count > 128 || recipe.Pads.Count > 512)
                throw new ArgumentException("This clearing baker supports up to 128 trails and 512 pads.");
            int pointCount = 0;
            foreach (GroundTrail trail in recipe.Trails)
            {
                if (trail == null) throw new ArgumentException("A trail entry is null.");
                RequireFinite(trail.Width, "Trail Width");
                RequireFinite(trail.Feather, "Trail Feather");
                if (trail.Width < .1f || trail.Width > 32f || trail.Feather < .05f || trail.Feather > 16f)
                    throw new ArgumentException("Trail width must be .1..32 metres and feather .05..16 metres.");
                if (trail.Points == null || trail.Points.Count < 2)
                    throw new ArgumentException("Every trail needs at least two distinct control points.");
                pointCount += trail.Points.Count;
                if (pointCount > 4096) throw new ArgumentException("The clearing supports at most 4096 trail control points.");
                for (int i = 0; i < trail.Points.Count; i++)
                {
                    RequireFinite(trail.Points[i], "Trail point");
                    RequireNearby(trail.Points[i], recipe, "Trail point");
                    if (i > 0 && (trail.Points[i] - trail.Points[i - 1]).sqrMagnitude < .0001f)
                        throw new ArgumentException("Consecutive trail points must be at least .01 metre apart.");
                }
            }
            foreach (GroundPad pad in recipe.Pads)
            {
                if (pad == null) throw new ArgumentException("A pad entry is null.");
                RequireFinite(pad.Center, "Pad Center");
                RequireFinite(pad.Size, "Pad Size");
                RequireFinite(pad.Height, "Pad Height");
                RequireFinite(pad.Feather, "Pad Feather");
                RequireNearby(pad.Center, recipe, "Pad Center");
                if (pad.Size.x <= 0f || pad.Size.y <= 0f || pad.Feather < .05f || pad.Feather > 16f)
                    throw new ArgumentException("Pad size must be positive, and feather must be .05..16 metres.");
                if (pad.Height < bottom || pad.Height > top)
                    throw new ArgumentException("Pad height must fit inside the Terrain Y range.");
            }
            // Optional lists may be missing from older serialized recipes.
            if (recipe.ForestRegions != null)
            {
                if (recipe.ForestRegions.Count > 32)
                    throw new ArgumentException("Ground supports up to 32 forest regions.");
                foreach (GroundForestRegion region in recipe.ForestRegions)
                {
                    if (region == null) throw new ArgumentException("A forest region is null.");
                    RequireFinite(region.Feather, "Forest feather");
                    if (region.Feather < .1f || region.Feather > 32f)
                        throw new ArgumentException("Forest feather must be .1..32 metres.");
                    ValidatePolygon(region.Points, recipe, "Forest");
                }
            }
            if (recipe.WaterRegions != null)
            {
                if (recipe.WaterRegions.Count > 32)
                    throw new ArgumentException("Ground supports up to 32 water regions.");
                foreach (GroundWaterRegion region in recipe.WaterRegions)
                {
                    if (region == null) throw new ArgumentException("A water region is null.");
                    RequireFinite(region.WaterHeight, "Water height");
                    RequireFinite(region.BedHeight, "Water bed height");
                    RequireFinite(region.BankFeather, "Water bank feather");
                    if (region.BedHeight < bottom || region.BedHeight >= region.WaterHeight ||
                        region.WaterHeight + .04f > top || region.BankFeather < .1f || region.BankFeather > 32f)
                        throw new ArgumentException("Water bed must be below its surface within the Terrain height range; bank feather must be .1..32 metres.");
                    ValidatePolygon(region.Points, recipe, "Water");
                }
            }
        }

        private static void ValidatePolygon(List<Vector2> points, GroundRecipe recipe, string name)
        {
            if (points == null || points.Count < 3 || points.Count > 256)
                throw new ArgumentException(name + " region needs a simple polygon with 3..256 vertices.");
            foreach (Vector2 point in points)
            {
                RequireFinite(point, name + " polygon point");
                RequireNearby(point, recipe, name + " polygon point");
            }
            double twiceArea = 0;
            for (int i = 0; i < points.Count; i++)
            {
                Vector2 a = points[i];
                Vector2 b = points[(i + 1) % points.Count];
                Vector2 previous = points[(i + points.Count - 1) % points.Count];
                if ((a - b).sqrMagnitude < .0001f)
                    throw new ArgumentException(name + " polygon vertices must be distinct; do not repeat the first vertex.");
                // Adjacent edges may be straight, but cannot double back over one another.
                if (Mathf.Abs(Cross(previous - a, b - a)) < .0001f &&
                    Vector2.Dot(previous - a, b - a) > 0f)
                    throw new ArgumentException(name + " polygon edges must not overlap.");
                twiceArea += (double)a.x * b.y - (double)b.x * a.y;
                for (int j = i + 2; j < points.Count; j++)
                {
                    if (i == 0 && j == points.Count - 1) continue;
                    Vector2 c = points[j];
                    Vector2 d = points[(j + 1) % points.Count];
                    if (SegmentsIntersect(a, b, c, d))
                        throw new ArgumentException(name + " polygon edges must not cross or touch themselves.");
                }
            }
            if (Math.Abs(twiceArea) < .01)
                throw new ArgumentException(name + " polygon must have a non-zero area.");
        }

        public float SamplePathWeight(Vector2 point)
        {
            if (!bins.TryGetValue(Bin(point), out List<int> candidates)) return 0f;
            // One coherent noise field perturbs all path edges, including intersections.
            float variation = Noise(point, .85f, 21f) * .16f - .08f;
            float weight = 0f;
            foreach (int index in candidates)
            {
                Segment segment = segments[index];
                float t = Mathf.Clamp01(Vector2.Dot(point - segment.A, segment.Delta) * segment.InverseLengthSquared);
                float distance = Vector2.Distance(point, segment.A + segment.Delta * t);
                float radius = segment.Radius * (1f + variation);
                float candidate = 1f - Smooth01((distance - radius) / segment.Feather);
                weight = Mathf.Max(weight, candidate);
            }
            return weight;
        }

        /// <summary>The exact baked curve, for Scene View guides and Editor validation.</summary>
        public IReadOnlyList<Vector2> GetTrailPoints(int trailIndex)
        {
            return trailCurves[trailIndex];
        }

        public float SampleHeight(Vector2 point)
        {
            float path = SamplePathWeight(point);
            float relief = (Noise(point, .115f, 0f) - .5f) * 1.5f
                + (Noise(point, .33f, 37f) - .5f) * .5f;
            float height = recipe.BaseHeight + relief * recipe.Relief * (1f - path * .94f)
                - path * recipe.PathDepression;
            SamplePad(point, out float padWeight, out float padHeight);
            height = Mathf.Lerp(height, padHeight, padWeight);
            foreach (WaterArea area in waterAreas)
            {
                float feather = area.Region.BankFeather;
                if (!NearWaterBounds(point, area, feather)) continue;
                float distance = SignedPolygonDistance(point, area.Region.Points);
                if (distance < -feather) continue;
                float shore = area.Region.WaterHeight + .04f;
                float carved = distance >= 0f
                    ? Mathf.Lerp(shore, area.Region.BedHeight, Smooth01(distance / feather))
                    : Mathf.Lerp(height, shore, 1f - Smooth01(-distance / feather));
                // The coast has priority over a misplaced foundation; validation catches submerged arrivals.
                height = Mathf.Min(height, carved);
            }
            return height;
        }

        /// <summary>Geometric water footprint, optionally expanded for bank/canopy clearance.</summary>
        public bool IsWater(Vector2 point, float margin = 0f)
        {
            foreach (WaterArea area in waterAreas)
                if (NearWaterBounds(point, area, Mathf.Max(0f, margin)) &&
                    SignedPolygonDistance(point, area.Region.Points) >= -margin) return true;
            return false;
        }

        /// <summary>Paint influence: zero on dry land, half at the polygon shore, one in deep water.</summary>
        public float SampleWaterWeight(Vector2 point)
        {
            float weight = 0f;
            foreach (WaterArea area in waterAreas)
            {
                float feather = area.Region.BankFeather;
                if (!NearWaterBounds(point, area, feather)) continue;
                float distance = SignedPolygonDistance(point, area.Region.Points);
                weight = Mathf.Max(weight, Smooth01((distance + feather) / (2f * feather)));
            }
            return weight;
        }

        /// <summary>Geometric forest footprint. Positive margins expand it; negative margins keep planting inside.</summary>
        public bool IsForest(Vector2 point, float margin = 0f)
        {
            foreach (ForestArea area in forestAreas)
                if (NearBounds(point, area.Min, area.Max, Mathf.Max(0f, margin)) &&
                    SignedPolygonDistance(point, area.Region.Points) >= -margin) return true;
            return false;
        }

        /// <summary>Paint influence: zero outside the feather, half on the outline, one inside.</summary>
        public float SampleForestWeight(Vector2 point)
        {
            float weight = 0f;
            foreach (ForestArea area in forestAreas)
            {
                float feather = area.Region.Feather;
                if (!NearBounds(point, area.Min, area.Max, feather)) continue;
                float distance = SignedPolygonDistance(point, area.Region.Points);
                weight = Mathf.Max(weight, Smooth01((distance + feather) / (2f * feather)));
            }
            return weight;
        }

        /// <summary>Four nonnegative normalized weights, matching Meadow/Moss/Soil/LeafLitter layers.</summary>
        public void SampleLayerWeights(Vector2 point, out float meadow, out float moss, out float soil, out float leafLitter)
        {
            float path = SamplePathWeight(point);
            float broadNoise = Noise(point, .14f, 61f);
            float smallNoise = Noise(point, .62f, 11f);
            float edgeDistance = Mathf.Min(
                Mathf.Min(point.x - recipe.Origin.x, recipe.Origin.x + recipe.Size.x - point.x),
                Mathf.Min(point.y - recipe.Origin.z, recipe.Origin.z + recipe.Size.z - point.y));
            float forestEdge = 1f - Smooth01((edgeDistance - .8f) / 5f);
            SamplePad(point, out float padWeight, out _);
            float padEdge = padWeight * (1f - padWeight) * 4f;

            meadow = .78f;
            moss = .06f + Smooth01((broadNoise - .37f) / .4f) * .52f;
            leafLitter = forestEdge * (.22f + smallNoise * .35f) + padEdge * .15f;
            soil = .025f + Smooth01((smallNoise - .68f) / .3f) * .12f;
            float total = meadow + moss + soil + leafLitter;
            if (forestAreas.Count > 0)
            {
                // Explicit masses replace the old noise-led clearing paint. Keep the open
                // corridors light and foundations clear even if an outline crosses a pad.
                float forest = SampleForestWeight(point) * (1f - padWeight);
                meadow = Mathf.Lerp(.88f, .025f, forest);
                moss = Mathf.Lerp(.065f, .60f + broadNoise * .08f, forest);
                soil = Mathf.Lerp(.035f, .045f, forest);
                leafLitter = Mathf.Lerp(.02f, .33f - broadNoise * .08f, forest);
                total = meadow + moss + soil + leafLitter;
            }
            float offTrail = 1f - path;
            meadow = meadow / total * offTrail;
            moss = moss / total * offTrail;
            soil = soil / total * offTrail + path * .94f;
            leafLitter = leafLitter / total * offTrail + path * .06f;
            float water = SampleWaterWeight(point);
            meadow *= 1f - water;
            moss *= 1f - water;
            soil = soil * (1f - water) + water * .94f;
            leafLitter = leafLitter * (1f - water) + water * .06f;
        }

        private static bool NearWaterBounds(Vector2 point, WaterArea area, float margin)
        {
            return NearBounds(point, area.Min, area.Max, margin);
        }

        private static bool NearBounds(Vector2 point, Vector2 min, Vector2 max, float margin)
        {
            return point.x >= min.x - margin && point.x <= max.x + margin &&
                point.y >= min.y - margin && point.y <= max.y + margin;
        }

        private static float SignedPolygonDistance(Vector2 point, List<Vector2> polygon)
        {
            bool inside = false;
            float minimumSquared = float.MaxValue;
            for (int i = 0, j = polygon.Count - 1; i < polygon.Count; j = i++)
            {
                Vector2 a = polygon[j];
                Vector2 b = polygon[i];
                Vector2 delta = b - a;
                float t = Mathf.Clamp01(Vector2.Dot(point - a, delta) / delta.sqrMagnitude);
                minimumSquared = Mathf.Min(minimumSquared, (point - a - delta * t).sqrMagnitude);
                if ((a.y > point.y) != (b.y > point.y) &&
                    point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x)
                    inside = !inside;
            }
            float distance = Mathf.Sqrt(minimumSquared);
            return inside ? distance : -distance;
        }

        private static bool SegmentsIntersect(Vector2 a, Vector2 b, Vector2 c, Vector2 d)
        {
            // Include touching nonadjacent edges: those polygons are ambiguous for triangulation.
            float abC = Cross(b - a, c - a);
            float abD = Cross(b - a, d - a);
            float cdA = Cross(d - c, a - c);
            float cdB = Cross(d - c, b - c);
            if (((abC > 0f && abD < 0f) || (abC < 0f && abD > 0f)) &&
                ((cdA > 0f && cdB < 0f) || (cdA < 0f && cdB > 0f))) return true;
            return (Mathf.Abs(abC) < .0001f && OnSegment(a, b, c)) ||
                (Mathf.Abs(abD) < .0001f && OnSegment(a, b, d)) ||
                (Mathf.Abs(cdA) < .0001f && OnSegment(c, d, a)) ||
                (Mathf.Abs(cdB) < .0001f && OnSegment(c, d, b));
        }

        private static float Cross(Vector2 a, Vector2 b) => a.x * b.y - a.y * b.x;

        private static bool OnSegment(Vector2 a, Vector2 b, Vector2 point)
        {
            return point.x >= Mathf.Min(a.x, b.x) - .0001f && point.x <= Mathf.Max(a.x, b.x) + .0001f &&
                point.y >= Mathf.Min(a.y, b.y) - .0001f && point.y <= Mathf.Max(a.y, b.y) + .0001f;
        }

        private void SamplePad(Vector2 point, out float weight, out float height)
        {
            weight = 0f;
            height = recipe.BaseHeight;
            float heightSum = 0f;
            float weightSum = 0f;
            foreach (GroundPad pad in recipe.Pads)
            {
                float dx = Mathf.Max(0f, Mathf.Abs(point.x - pad.Center.x) - pad.Size.x * .5f);
                float dz = Mathf.Max(0f, Mathf.Abs(point.y - pad.Center.y) - pad.Size.y * .5f);
                if (dx >= pad.Feather || dz >= pad.Feather) continue;
                float distance = Mathf.Sqrt(dx * dx + dz * dz);
                if (distance >= pad.Feather) continue;
                float influence = 1f - Smooth01(distance / pad.Feather);
                if (influence >= .99999f)
                {
                    // The first overlapping core wins deterministically; feather from nearby pads
                    // cannot move an existing building's level foundation.
                    weight = 1f;
                    height = pad.Height;
                    return;
                }
                weight = Mathf.Max(weight, influence);
                weightSum += influence;
                heightSum += pad.Height * influence;
            }
            if (weightSum > 0f) height = heightSum / weightSum;
        }

        private void AddTrail(GroundTrail trail)
        {
            var curve = new List<Vector2> { trail.Points[0] };
            trailCurves.Add(curve);
            for (int i = 0; i < trail.Points.Count - 1; i++)
            {
                Vector2 p1 = trail.Points[i];
                Vector2 p2 = trail.Points[i + 1];
                // Mirrored end handles keep two-point trails straight and endpoint tangents natural.
                Vector2 p0 = i > 0 ? trail.Points[i - 1] : p1 * 2f - p2;
                Vector2 p3 = i + 2 < trail.Points.Count ? trail.Points[i + 2] : p2 * 2f - p1;
                float estimatedLength = Vector2.Distance(p1, p2)
                    + .25f * (Vector2.Distance(p0, p1) + Vector2.Distance(p2, p3));
                int steps = Mathf.Max(2, Mathf.CeilToInt(estimatedLength / CurveStep));
                Vector2 previous = p1;
                for (int step = 1; step <= steps; step++)
                {
                    Vector2 next = CatmullRom(p0, p1, p2, p3, step / (float)steps);
                    AddSegment(previous, next, trail.Width * .5f, trail.Feather);
                    curve.Add(next);
                    previous = next;
                }
            }
        }

        private void AddSegment(Vector2 a, Vector2 b, float radius, float feather)
        {
            Vector2 delta = b - a;
            if (delta.sqrMagnitude < .00000001f) return;
            if (segments.Count >= 16384)
                throw new ArgumentException("Ground trails are too dense for this small-clearing baker. Use fewer control points.");
            var segment = new Segment { A = a, Delta = delta, InverseLengthSquared = 1f / delta.sqrMagnitude,
                Radius = radius, Feather = feather };
            int index = segments.Count;
            segments.Add(segment);
            float reach = radius * 1.08f + feather;
            Vector2Int low = Bin(Vector2.Min(a, b) - Vector2.one * reach);
            Vector2Int high = Bin(Vector2.Max(a, b) + Vector2.one * reach);
            for (int y = low.y; y <= high.y; y++)
                for (int x = low.x; x <= high.x; x++)
                {
                    var key = new Vector2Int(x, y);
                    if (!bins.TryGetValue(key, out List<int> indices))
                    {
                        indices = new List<int>();
                        bins.Add(key, indices);
                    }
                    indices.Add(index);
                }
        }

        private float Noise(Vector2 point, float frequency, float salt)
        {
            return Mathf.Clamp01(Mathf.PerlinNoise(point.x * frequency + noiseOffset.x + salt,
                point.y * frequency + noiseOffset.y + salt * .71f));
        }

        private static Vector2 CatmullRom(Vector2 p0, Vector2 p1, Vector2 p2, Vector2 p3, float t)
        {
            float t2 = t * t;
            return .5f * ((2f * p1) + (-p0 + p2) * t
                + (2f * p0 - 5f * p1 + 4f * p2 - p3) * t2
                + (-p0 + 3f * p1 - 3f * p2 + p3) * (t2 * t));
        }

        private static Vector2Int Bin(Vector2 point)
        {
            return new Vector2Int(Mathf.FloorToInt(point.x / BinSize), Mathf.FloorToInt(point.y / BinSize));
        }

        private static float Smooth01(float value)
        {
            value = Mathf.Clamp01(value);
            return value * value * (3f - 2f * value);
        }

        private static void RequireNearby(Vector2 value, GroundRecipe recipe, string name)
        {
            const float margin = 32f;
            if (value.x < recipe.Origin.x - margin || value.x > recipe.Origin.x + recipe.Size.x + margin ||
                value.y < recipe.Origin.z - margin || value.y > recipe.Origin.z + recipe.Size.z + margin)
                throw new ArgumentException(name + " must lie on or within 32 metres of the Terrain.");
        }

        private static void RequireFinite(Vector3 value, string name)
        {
            RequireFinite(value.x, name); RequireFinite(value.y, name); RequireFinite(value.z, name);
        }

        private static void RequireFinite(Vector2 value, string name)
        {
            RequireFinite(value.x, name); RequireFinite(value.y, name);
        }

        private static void RequireFinite(float value, string name)
        {
            if (float.IsNaN(value) || float.IsInfinity(value)) throw new ArgumentException(name + " must be finite.");
        }
    }
}

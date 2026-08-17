/**
 * Procedural noise-displaced icosphere generation for the orb.
 *
 * A smooth sphere is the reason the orb reads flat: with no surface detail its
 * silhouette is a circle from every angle, so rotation is invisible and there is
 * nothing for the fresnel rim to catch. Displacing the vertices by fbm noise
 * gives the orb a real, irregular silhouette that changes as it turns — which is
 * what makes it read as a volume rather than a disc.
 *
 * Displacement is done in geometry rather than in a shader because the shader
 * library's materials ship with their texture/animation paths behind compile
 * time `#define`s, and package materials cannot be duplicated to flip them.
 *
 * Meshes are cached by their parameters and shared between orbs — every note
 * uses the same shape, only its transform and material differ, so generating
 * one mesh per note would waste both time and memory.
 */

/** Vertex layout used for every generated orb mesh. */
const VERTEX_LAYOUT = [
  { name: "position", components: 3 },
  { name: "normal", components: 3 },
  { name: "texture0", components: 2 }
]

export interface OrbMeshParams {
  /** Icosahedron subdivision count. 2 = 162 verts, 3 = 642 verts. */
  subdivisions: number
  /** Spatial frequency of the noise. Higher gives finer detail. */
  noiseScale: number
  /** Number of fbm octaves. */
  octaves: number
  /** Displacement as a fraction of the unit radius. */
  amplitude: number
  /** Varies the shape without changing any other parameter. */
  seed: number
}

const meshCache: { [key: string]: RenderMesh } = {}

function cacheKey(params: OrbMeshParams): string {
  return (
    params.subdivisions +
    "|" +
    params.noiseScale +
    "|" +
    params.octaves +
    "|" +
    params.amplitude +
    "|" +
    params.seed
  )
}

/** Builds (or returns a cached) displaced sphere mesh. */
export function getOrbMesh(params: OrbMeshParams): RenderMesh | null {
  const key = cacheKey(params)

  if (meshCache[key] !== undefined) {
    return meshCache[key]
  }

  const mesh = buildOrbMesh(params)

  if (mesh !== null) {
    meshCache[key] = mesh
  }

  return mesh
}

interface Vec3Lite {
  x: number
  y: number
  z: number
}

function buildOrbMesh(params: OrbMeshParams): RenderMesh | null {
  try {
    const geometry = buildIcosphere(clampInt(params.subdivisions, 0, 4))
    const builder = new MeshBuilder(VERTEX_LAYOUT)
    builder.topology = MeshTopology.Triangles
    builder.indexType = MeshIndexType.UInt16

    const positions = geometry.positions
    const displaced: Vec3Lite[] = []

    // Displace along the surface normal, which for a unit sphere is the
    // position itself.
    for (let i = 0; i < positions.length; i++) {
      const p = positions[i]
      const n = fbm3(
        p.x * params.noiseScale,
        p.y * params.noiseScale,
        p.z * params.noiseScale,
        clampInt(params.octaves, 1, 6),
        params.seed
      )

      // fbm returns roughly [0, 1]; centre it so the orb neither inflates nor
      // shrinks on average, only deforms.
      const offset = 1 + (n - 0.5) * 2 * params.amplitude

      displaced.push({ x: p.x * offset, y: p.y * offset, z: p.z * offset })
    }

    const normals = computeNormals(displaced, geometry.indices)
    const interleaved: number[] = []

    for (let i = 0; i < displaced.length; i++) {
      const p = displaced[i]
      const n = normals[i]

      interleaved.push(p.x, p.y, p.z)
      interleaved.push(n.x, n.y, n.z)

      // Spherical UVs. The seam is acceptable: these materials are rim and glow
      // driven, so no texture is sampled across it.
      const u = 0.5 + Math.atan2(p.z, p.x) / (2 * Math.PI)
      const v = 0.5 - Math.asin(clamp(p.y / Math.max(0.0001, length(p)), -1, 1)) / Math.PI
      interleaved.push(u, v)
    }

    builder.appendVerticesInterleaved(interleaved)
    builder.appendIndices(geometry.indices)

    if (!builder.isValid()) {
      print("[OrbGeometry] Generated mesh is invalid.")
      return null
    }

    builder.updateMesh()
    return builder.getMesh()
  } catch (e) {
    print("[OrbGeometry] Failed to build orb mesh: " + e)
    return null
  }
}

interface Geometry {
  positions: Vec3Lite[]
  indices: number[]
}

/**
 * Icosahedron subdivided `subdivisions` times and projected onto a unit sphere.
 *
 * An icosphere is used rather than a UV sphere because its triangles are
 * near-uniform in size, so noise displacement is even across the surface
 * instead of bunching at the poles.
 */
function buildIcosphere(subdivisions: number): Geometry {
  const t = (1 + Math.sqrt(5)) / 2

  let positions: Vec3Lite[] = [
    { x: -1, y: t, z: 0 },
    { x: 1, y: t, z: 0 },
    { x: -1, y: -t, z: 0 },
    { x: 1, y: -t, z: 0 },
    { x: 0, y: -1, z: t },
    { x: 0, y: 1, z: t },
    { x: 0, y: -1, z: -t },
    { x: 0, y: 1, z: -t },
    { x: t, y: 0, z: -1 },
    { x: t, y: 0, z: 1 },
    { x: -t, y: 0, z: -1 },
    { x: -t, y: 0, z: 1 }
  ]

  for (let i = 0; i < positions.length; i++) {
    positions[i] = normalize(positions[i])
  }

  let indices: number[] = [
    0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11,
    1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
    3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9,
    4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1
  ]

  for (let s = 0; s < subdivisions; s++) {
    const midpoints: { [key: string]: number } = {}
    const nextIndices: number[] = []

    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i]
      const b = indices[i + 1]
      const c = indices[i + 2]

      const ab = midpointIndex(a, b, positions, midpoints)
      const bc = midpointIndex(b, c, positions, midpoints)
      const ca = midpointIndex(c, a, positions, midpoints)

      nextIndices.push(a, ab, ca)
      nextIndices.push(b, bc, ab)
      nextIndices.push(c, ca, bc)
      nextIndices.push(ab, bc, ca)
    }

    indices = nextIndices
  }

  return { positions: positions, indices: indices }
}

function midpointIndex(
  a: number,
  b: number,
  positions: Vec3Lite[],
  cache: { [key: string]: number }
): number {
  const key = a < b ? a + "_" + b : b + "_" + a

  if (cache[key] !== undefined) {
    return cache[key]
  }

  const pa = positions[a]
  const pb = positions[b]
  const mid = normalize({
    x: (pa.x + pb.x) * 0.5,
    y: (pa.y + pb.y) * 0.5,
    z: (pa.z + pb.z) * 0.5
  })

  positions.push(mid)
  const index = positions.length - 1
  cache[key] = index

  return index
}

/** Area-weighted vertex normals from the displaced positions. */
function computeNormals(positions: Vec3Lite[], indices: number[]): Vec3Lite[] {
  const normals: Vec3Lite[] = []

  for (let i = 0; i < positions.length; i++) {
    normals.push({ x: 0, y: 0, z: 0 })
  }

  for (let i = 0; i < indices.length; i += 3) {
    const ia = indices[i]
    const ib = indices[i + 1]
    const ic = indices[i + 2]

    const a = positions[ia]
    const b = positions[ib]
    const c = positions[ic]

    const abx = b.x - a.x
    const aby = b.y - a.y
    const abz = b.z - a.z
    const acx = c.x - a.x
    const acy = c.y - a.y
    const acz = c.z - a.z

    // Cross product magnitude is proportional to triangle area, so accumulating
    // the raw cross product weights each face by its size automatically.
    const nx = aby * acz - abz * acy
    const ny = abz * acx - abx * acz
    const nz = abx * acy - aby * acx

    normals[ia].x += nx
    normals[ia].y += ny
    normals[ia].z += nz
    normals[ib].x += nx
    normals[ib].y += ny
    normals[ib].z += nz
    normals[ic].x += nx
    normals[ic].y += ny
    normals[ic].z += nz
  }

  for (let i = 0; i < normals.length; i++) {
    normals[i] = normalize(normals[i])
  }

  return normals
}

// ------------------------------------------------------------------- noise

/** Deterministic hash in [0, 1] from an integer lattice point and a seed. */
function hash3(x: number, y: number, z: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + z * 2147483647 + seed * 971
  h = (h ^ (h >> 13)) * 1274126177
  h = h ^ (h >> 16)
  return (h >>> 0) / 4294967295
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t)
}

/** Trilinearly interpolated value noise. */
function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const zi = Math.floor(z)

  const xf = smoothstep(x - xi)
  const yf = smoothstep(y - yi)
  const zf = smoothstep(z - zi)

  const c000 = hash3(xi, yi, zi, seed)
  const c100 = hash3(xi + 1, yi, zi, seed)
  const c010 = hash3(xi, yi + 1, zi, seed)
  const c110 = hash3(xi + 1, yi + 1, zi, seed)
  const c001 = hash3(xi, yi, zi + 1, seed)
  const c101 = hash3(xi + 1, yi, zi + 1, seed)
  const c011 = hash3(xi, yi + 1, zi + 1, seed)
  const c111 = hash3(xi + 1, yi + 1, zi + 1, seed)

  const x00 = c000 + (c100 - c000) * xf
  const x10 = c010 + (c110 - c010) * xf
  const x01 = c001 + (c101 - c001) * xf
  const x11 = c011 + (c111 - c011) * xf

  const y0 = x00 + (x10 - x00) * yf
  const y1 = x01 + (x11 - x01) * yf

  return y0 + (y1 - y0) * zf
}

/** Fractal brownian motion: octaves of value noise at doubling frequency. */
export function fbm3(
  x: number,
  y: number,
  z: number,
  octaves: number,
  seed: number
): number {
  let value = 0
  let amplitude = 0.5
  let frequency = 1
  let total = 0

  for (let i = 0; i < octaves; i++) {
    value += valueNoise3(x * frequency, y * frequency, z * frequency, seed + i * 17) * amplitude
    total += amplitude
    amplitude *= 0.5
    frequency *= 2
  }

  return total > 0 ? value / total : 0
}

// ------------------------------------------------------------------ helpers

function length(v: Vec3Lite): number {
  return Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z)
}

function normalize(v: Vec3Lite): Vec3Lite {
  const len = length(v)
  if (len < 0.000001) {
    return { x: 0, y: 1, z: 0 }
  }
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max))
}

#!/usr/bin/env python3
# =============================================================================
# sea-inland.py — one-off generator of the "sea on today's land" outlines and of
# the remnant ice of the Laurentide ice sheet for maps 5000 and 6000
# (items 5000bc-14 … 5000bc-17 and 6-408, 21.11.2026; analysis in
# corrections/archive/5000/_общее/2026-11-21 Море вглубь суши — разбор …).
#
# The build itself can only LOWER the sea (coast.mjs). Where the sea stood higher
# than today (land rising after the ice age; the head of the Persian Gulf), the
# flooded land is drawn through the vanished-lakes mechanism: outlines written to
# corrections/lakes/sea-*-<year>.geojson and listed under "lakes" in
# corrections/sea-levels.json are cut out of the land of that year and painted
# in the sea colour. The build does not need this script or Python; run it again
# only to redraw the outlines (e.g. for maps 4000 and 3000).
#
#   1. Fennoscandia (5000bc-14): Påsse 2001 (SKB TR-01-41), empirical shore
#      displacement model S = U − E, parameters of 73 sites (table 3-1; site
#      coordinates placed by Claude from the place names, ±10–30 km). S is
#      interpolated over the ETOPO1 10' grid (inverse distance, 6 nearest sites);
#      a land cell is sea when its height is below S (S > 0) and it is connected to
#      the sea. Pieces under 300 km² (grid noise along the coast) are dropped; the
#      sea cells next to the flooded land are added, so that no thin strip of
#      today's coast is left between the old and the new sea.
#   2. Hudson Bay and the Arctic coast of Canada (5000bc-15): Dyke et al. 2003
#      (GSC Open File 1574, shapefiles; SYMB = ICE / LAND / LAKE / WATER). Sea = land
#      of the year that Dyke has as neither land, ice nor lake; slivers from the
#      different coastlines are removed (opening 3 km, pieces < 300 km²); only east
#      of 125° W (on the Pacific side the difference is between coastlines, not land
#      uplift).
#   3. Head of the Persian Gulf (5000bc-16, map 5000 only): fixed outline — Iran
#      after Heyvaert & Baeteman 2007, fig. 11b; Iraq after Sanlaville &
#      Dalongeville 2005, fig. 2.
#   4. Ice (5000bc-17 b, 6-408 a): Dyke 2003 ICE — map 5000: 6 ka 14C slice, the
#      Labrador dome and the Melville Peninsula; map 6000: 7.2 ka 14C slice, the
#      Labrador dome and the Keewatin–Foxe ice (no Cordilleran / Alaskan glaciers,
#      no ice caps of the Arctic islands and Greenland).
#
# Land of the year: map 5000 — today's land (node_modules/world-atlas/land-50m.json);
# map 6000 — data/coast/land_-6000.json built WITHOUT these seas (e.g. from the git
# version before stage 47, or a build with the sea-* names taken out of "lakes"),
# because the land at −20 m reaches further than today's.
#
# Usage (from the project folder; needs numpy, h5py, shapely, pyproj, pyshp, scipy):
#   python3 tools/sea-inland.py <folder with Dyke's shapefiles: ice6k.shp, ice72k.shp> <land_-6000.json without the seas>
# =============================================================================

import json, math, os, sys
from collections import deque
import numpy as np
import h5py
import shapefile
from pyproj import CRS, Transformer
from scipy import ndimage
from shapely.geometry import shape, mapping, box, Polygon, MultiPolygon, Point
from shapely.ops import transform, unary_union
from shapely.prepared import prep
from shapely.validation import make_valid

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DYKE = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'Источники', '-5к', 'of_1574', 'data', 'shp')
LAKES = os.path.join(ROOT, 'corrections', 'lakes')
SHAPES = os.path.join(ROOT, 'corrections', 'shapes')
MIN_PIECE = 300e6  # m², smaller pieces are grid / coastline noise
MARGIN = float(os.environ.get('SEA_INLAND_MARGIN', 2))  # m, see fennoscandia()

def polys(g):
    if g.is_empty: return []
    if isinstance(g, Polygon): return [g]
    if isinstance(g, MultiPolygon): return list(g.geoms)
    return [p for x in getattr(g, 'geoms', []) for p in polys(x)]

def proj(lat0, lon0):
    p = f'+proj=laea +lat_0={lat0} +lon_0={lon0} +datum=WGS84'
    return (Transformer.from_crs('EPSG:4326', p, always_xy=True).transform,
            Transformer.from_crs(p, 'EPSG:4326', always_xy=True).transform)

def write(path, geom, props):
    import shapely
    # 4 decimals ≈ 10 m: enough for a 10' grid / a 1:7.5 M shapefile; set_precision keeps it valid
    geom = shapely.set_precision(make_valid(geom), 1e-4)
    # drop degenerate slivers; outer rings clockwise, holes counter-clockwise — the winding d3
    # expects on the sphere (a ring wound the other way is drawn as the whole world minus it)
    # Slivers thinner than 1 km are dropped too: near the pole the great-circle edges of such a
    # sliver can cross and d3 then reads it the other way round.
    from shapely.geometry.polygon import orient
    def solid(p):
        fwd, _ = proj(p.representative_point().y, p.representative_point().x)
        return not transform(fwd, p).buffer(-500).is_empty
    geom = MultiPolygon([orient(p, -1.0) for p in polys(geom) if p.area > 1e-4 and solid(p)])
    fc = {'type': 'FeatureCollection', 'features': [{'type': 'Feature', 'properties': props, 'geometry': mapping(geom)}]}
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(fc, f, ensure_ascii=False)
    print('  wrote', os.path.relpath(path, ROOT), '— valid' if geom.is_valid else '— INVALID')

# --- TopoJSON (world-atlas land, data/coast/land_<year>.json) -------------------
def topo_land(file, bbox):
    t = json.load(open(file, encoding='utf-8'))
    sx, sy = t['transform']['scale'] if 'transform' in t else (1, 1)
    tx, ty = t['transform']['translate'] if 'transform' in t else (0, 0)
    arcs = []
    for a in t['arcs']:
        x = y = 0; pts = []
        for p in a:
            if 'transform' in t: x += p[0]; y += p[1]; pts.append((x * sx + tx, y * sy + ty))
            else: pts.append(tuple(p))
        arcs.append(pts)
    def ring(ids):
        out = []
        for i in ids:
            pts = arcs[i] if i >= 0 else arcs[~i][::-1]
            out.extend(pts if not out else pts[1:])
        return out
    out = []
    obj = t['objects']['land']
    geoms = obj['geometries'] if obj['type'] == 'GeometryCollection' else [obj]
    clip = box(*bbox)
    def unwrap(r):  # outlines crossing the date line (Eurasia: Chukotka) → continuous longitudes
        shift = 0; res = [r[0]]
        for a, b in zip(r, r[1:]):
            dlon = b[0] - a[0]
            if dlon > 180: shift -= 360
            elif dlon < -180: shift += 360
            res.append((b[0] + shift, b[1]))
        return res
    for g in geoms:
        ps = [g['arcs']] if g['type'] == 'Polygon' else g['arcs']
        for p in ps:
            rings = [unwrap(ring(r)) for r in p]
            poly = make_valid(Polygon(rings[0], rings[1:]))
            for k in (-360, 0, 360):  # the same outline seen through the clip box shifted by a turn
                c = box(bbox[0] + k, bbox[1], bbox[2] + k, bbox[3])
                if poly.intersects(c):
                    piece = poly.intersection(c)
                    out.append(transform(lambda x, y, z=None: (np.asarray(x) - k, y), piece) if k else piece)
    return make_valid(unary_union(out))

LAND_6000 = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, 'data', 'coast', 'land_-6000.json')
def land_of(year, bbox):
    if year == -5000: return topo_land(os.path.join(ROOT, 'node_modules', 'world-atlas', 'land-50m.json'), bbox)
    return topo_land(LAND_6000, bbox)

# --- 1. Fennoscandia: Påsse 2001 ------------------------------------------------
# nr, site, As, Bs, Af, Tf, Bf (table 3-1), lon, lat (Claude, by place name)
PASSE = [(1,'Varanger',170,3400,20,11400,800,29.5,70.1),(2,'Andøya',91,3200,20,11200,1100,15.9,69.2),(3,'Tromsø',125,3300,24,11200,900,18.95,69.65),
(4,'Lofoten',105,3200,18,11200,1000,13.9,68.2),(5,'Nærøy',260,3500,55,11200,800,11.3,64.8),(6,'Verdalsøra',295,3600,55,11200,750,11.48,63.8),
(7,'Frosta',290,3600,50,11200,750,10.73,63.57),(8,'Bjugn',210,3400,50,11200,850,9.8,63.77),(9,'Hitra',180,3400,34,11200,850,8.85,63.55),
(10,'Tjeldbergodden',178,3400,36,11200,850,8.75,63.4),(11,'Frøya',152,3300,23,11000,800,8.7,63.7),(12,'Leinøy',99,3150,18,11400,800,5.6,62.3),
(13,'Fonnes',118,3300,35,11400,1000,4.95,60.8),(14,'Sotra',120,3300,34,11400,900,5.1,60.3),(15,'Bømlo',118,3300,30,11400,1000,5.2,59.75),
(16,'Yrkje',118,3300,40,11400,800,5.75,59.5),(17,'Hardanger',215,3400,55,11400,800,6.5,60.3),(18,'Jæren',93,3200,38,11400,1000,5.65,58.75),
(19,'Kragerø',215,3300,70,11400,800,9.4,58.87),(20,'Porsgrunn',235,3400,75,11400,800,9.66,59.14),(21,'Vestfold',245,3400,60,11400,800,10.2,59.3),
(22,'Oslo',320,3400,90,11400,800,10.75,59.9),(23,'Østfold',260,3400,55,11400,700,11.1,59.3),(24,'Østfold N',285,3400,65,11400,800,11.3,59.6),
(25,'Ski',310,3400,80,11400,900,10.83,59.72),(26,'Jylland',120,3100,7,11600,300,10.2,57.4),(27,'Vedbæk',98,2500,5,11600,250,12.57,55.85),
(28,'Søborg Sø',96,2400,5,11600,250,12.3,56.08),(29,'St Bælt',65,2300,5,11600,250,11.0,55.3),(30,'Kroppefjäll',255,3500,25,11500,500,12.2,58.6),
(31,'Hunneberg',237,3650,23,11600,450,12.5,58.35),(32,'Central Bohuslän',225,3400,22,11600,450,11.6,58.3),(33,'Ljungskile',205,3450,20,11600,450,11.92,58.22),
(34,'Risveden',198,3450,22,11600,450,12.2,58.05),(35,'Göteborg',162,3400,10,11600,300,11.95,57.7),(36,'Sandsjöbacka',155,3400,8,11600,300,12.0,57.55),
(37,'Fjärås',148,3350,6,11600,300,12.15,57.45),(38,'Varberg',132,3300,5,11600,300,12.25,57.1),(39,'Falkenberg',122,3250,5,11600,300,12.5,56.9),
(40,'Halmstad',116,2850,5,11600,300,12.86,56.67),(41,'Bjäre',111,2800,5,11600,300,12.75,56.35),(42,'Barsebäck',97,2300,5,11600,250,13.0,55.75),
(43,'Blekinge',122,2400,22,11600,350,15.3,56.2),(44,'Öland',125,2450,22,11600,375,16.6,56.7),(45,'Oskarshamn',163,2600,24,11600,400,16.45,57.27),
(46,'Gotland',169,2600,17,11600,300,18.5,57.5),(47,'NE Småland',195,4000,40,11600,400,16.6,57.75),(48,'Rejmyra',230,4700,75,11600,600,15.9,58.83),
(49,'Stockholm',235,6200,85,11600,650,18.05,59.33),(50,'Eskilstuna',255,6200,90,11500,700,16.5,59.37),(51,'Närke',255,4700,70,11500,600,15.2,59.25),
(52,'Gästrikland',320,7500,105,11400,1000,17.0,60.7),(53,'Hälsingland',355,7900,140,11400,1600,17.0,61.7),(54,'Ångermanland',380,8800,160,11400,1900,17.8,63.0),
(55,'S Västerbotten',380,9000,160,11400,1900,20.0,64.0),(56,'Rovaniemi',330,9000,145,11400,1300,25.7,66.5),(57,'Lauhanvuori',320,8800,145,11500,1250,22.17,62.15),
(58,'Olkiluoto',258,7600,90,11600,850,21.44,61.24),(59,'Åland',258,7200,90,11600,850,20.0,60.2),(60,'Turku',230,6800,85,11600,800,22.27,60.45),
(61,'Karjalohja',198,5700,75,11600,750,23.7,60.25),(62,'Tammisaari',190,5500,75,11600,675,23.43,59.97),(63,'Lohja',190,5600,75,11600,750,24.07,60.25),
(64,'Espoo',180,4800,72,11600,675,24.65,60.2),(65,'Porvoo',168,4400,70,11600,750,25.66,60.4),(66,'Hangassuo',165,4300,60,11600,750,26.3,60.6),
(67,'St Petersburg',95,3200,25,11500,400,30.3,59.9),(68,'Narva',115,2700,38,11800,250,28.2,59.38),(69,'Tallinn',165,3200,40,11800,250,24.75,59.44),
(70,'Köpu',165,3600,55,11800,350,22.2,58.92),(71,'S Lithuania',105,2200,18,11600,200,21.1,55.7),(72,'W Baltic',45,2200,0,11600,150,10.8,54.4),
(73,'Dalnie Zelentsy',138,3100,22,11500,950,36.1,69.1)]
def passe_S(t, r):  # height of the shoreline at t cal BP above today's sea level, m
    _, _, As, Bs, Af, Tf, Bf, _, _ = r
    E = 2 / math.pi * 56 * (math.atan(9500 / 1350) - math.atan((9500 - t) / 1350))
    Us = 2 / math.pi * As * (math.atan(12000 / Bs) - math.atan((12000 - t) / Bs))
    Uf = Af * math.exp(-0.5 * ((t - Tf) / Bf) ** 2) - Af * math.exp(-0.5 * ((0 - Tf) / Bf) ** 2)
    return Us + Uf - E
# Area of the model: Norway, Sweden, Finland, Denmark, Estonia, the eastern Gulf of
# Finland to 31.5° E (no White Sea / Kola: no model sites there)
FENNO_AREA = Polygon([(4,57.5),(8,57.5),(10.5,56.8),(12.6,55.3),(14.5,55.2),(19,54.6),(21.5,56.5),(23.5,57.2),(28.5,59.2),(31.5,59.6),(31.5,62),(30,64),(29.5,67),(29,69.5),(33,70.5),(34,72),(4,72),(4,57.5)])

def fennoscandia(year, t_calbp):
    f = h5py.File(os.path.join(ROOT, 'tools', '.cache', 'etopo', 'earth-topography-10arcmin.nc'), 'r')
    z = f['topography'][:][:, :-1].astype('f4'); st = 1 / 6
    lat_all = -90 + np.arange(z.shape[0]) * st; lon_all = -180 + np.arange(z.shape[1]) * st
    jj = np.where((lat_all >= 53) & (lat_all <= 73))[0]; ii = np.where((lon_all >= 2) & (lon_all <= 36))[0]
    z = z[jj[0]:jj[-1] + 1, ii[0]:ii[-1] + 1]; lat = lat_all[jj]; lon = lon_all[ii]
    X, Y = np.meshgrid(lon, lat); ny, nx = z.shape
    land = prep(land_of(year, (0, 50, 40, 75)))
    area = prep(FENNO_AREA)
    is_land = np.array([[land.contains(Point(X[j, i], Y[j, i])) for i in range(nx)] for j in range(ny)])
    modern = land if year == -5000 else prep(land_of(-5000, (0, 50, 40, 75)))
    is_modern = is_land if year == -5000 else np.array([[modern.contains(Point(X[j, i], Y[j, i])) for i in range(nx)] for j in range(ny)])
    inside = np.array([[area.contains(Point(X[j, i], Y[j, i])) for i in range(nx)] for j in range(ny)])
    # S over the grid: inverse distance, 6 nearest sites
    sl = np.array([r[7] for r in PASSE]); sa = np.array([r[8] for r in PASSE]); sv = np.array([passe_S(t_calbp, r) for r in PASSE])
    S = np.full(z.shape, np.nan, 'f4'); idx = np.where(inside)
    px, py = X[idx], Y[idx]
    d = np.hypot((px[:, None] - sl[None, :]) * np.cos(np.radians(py[:, None])), py[:, None] - sa[None, :]) * 111 + 1
    k = np.argsort(d, axis=1)[:, :6]; dd = np.take_along_axis(d, k, 1); w = 1 / dd ** 2
    S[idx] = (w * sv[k]).sum(1) / w.sum(1)
    # flood from the sea through land cells below S
    # a cell is drowned when it lies at least MARGIN below the shoreline of the model (and the
    # shoreline is at least MARGIN above today's sea): near the zero line of the model (southern
    # Scania: submerged sites of Foteviken bay) and right at the ancient shore (coastal sites,
    # 18 km cells) the model and the grid are not that precise. Today's land with a height below
    # 0 m on the grid is a narrow island or a strip of coast with the sea averaged in (Öland):
    # its real height is unknown, so it is not drowned; the shelf that is land only on map 6000
    # (sea level −20 m) is.
    cand = inside & is_land & (S >= MARGIN) & (z <= S - MARGIN) & ((z >= 0) | ~is_modern)
    fl = np.zeros(z.shape, bool); q = deque()
    sea = ~is_land
    for j in range(ny):
        for i in range(nx):
            if cand[j, i] and any(0 <= a < ny and 0 <= b < nx and sea[a, b] for a, b in ((j+1,i),(j-1,i),(j,i+1),(j,i-1))):
                fl[j, i] = True; q.append((j, i))
    while q:
        j, i = q.popleft()
        for a, b in ((j+1,i),(j-1,i),(j,i+1),(j,i-1)):
            if 0 <= a < ny and 0 <= b < nx and cand[a, b] and not fl[a, b]: fl[a, b] = True; q.append((a, b))
    cell = (st * 111.2e3) ** 2 * np.cos(np.radians(Y))
    lab, n = ndimage.label(fl)
    sizes = ndimage.sum(cell, lab, range(1, n + 1))
    fl = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= MIN_PIECE])
    print(f'  Fennoscandia {year}: {cell[fl].sum() / 1e6:,.0f} km² of land under the sea ({len([s for s in sizes if s >= MIN_PIECE])} pieces)')
    # add the sea cells next to the flooded land (8 neighbours), then trace a smooth outline:
    # the mask is blurred (Gaussian, 0.8 cell), upsampled 4x (bilinear) and cut at 0.5
    mask = fl | (ndimage.binary_dilation(fl, structure=np.ones((3, 3))) & sea)
    up = 4
    pad = ndimage.gaussian_filter(np.pad(mask.astype('f4'), 3), 0.8)
    m = ndimage.zoom(pad, up, order=1) >= 0.5
    # output pixel k sits at input index k*(Nin-1)/(Nout-1); input index i is at lon[0] + (i-1)*st
    kx = (pad.shape[1] - 1) / (m.shape[1] - 1); ky = (pad.shape[0] - 1) / (m.shape[0] - 1)
    dx, dy = kx * st, ky * st
    cells = []
    for j, i in zip(*np.where(m)):
        x = lon[0] + (i * kx - 3) * st; y = lat[0] + (j * ky - 3) * st
        cells.append(box(x - dx / 2, y - dy / 2, x + dx / 2, y + dy / 2))
    g = unary_union(cells)
    fwd, inv = proj(62, 18)
    gp = transform(fwd, g).simplify(1500)
    gp = unary_union([p for p in polys(gp) if p.area >= MIN_PIECE / 3])
    return transform(inv, gp), cell[fl].sum() / 1e6

# --- 2. Hudson Bay: Dyke 2003 ---------------------------------------------------
# All work on Dyke's polygons is done in their own projection (Lambert conformal conic,
# metres): the outer WATER polygon covers the whole map, and in degrees such huge
# polygons come out distorted. Areas are measured in an equal-area projection.
def dyke(slice_name):
    crs = CRS.from_wkt(open(os.path.join(DYKE, slice_name + '.prj')).read())
    to_native = Transformer.from_crs('EPSG:4326', crs, always_xy=True).transform
    to_lonlat = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True).transform
    # The shapefiles were exported from coverages without holes: an island may be a separate
    # polygon lying inside a WATER polygon, a bay inside a LAND polygon, and so on.
    # A point belongs to the smallest polygon that contains it, so every polygon loses
    # the polygons nested in it.
    from shapely.strtree import STRtree
    recs = []
    for sr in shapefile.Reader(os.path.join(DYKE, slice_name)).iterShapeRecords():
        g = make_valid(shape(sr.shape.__geo_interface__)).buffer(0)
        if not g.is_empty: recs.append((g, sr.record[-1]))
    geoms = [g for g, _ in recs]
    tree = STRtree(geoms)
    out = {'ICE': [], 'LAND': [], 'LAKE': [], 'WATER': []}
    for i, (g, s) in enumerate(recs):
        inner = [geoms[j] for j in tree.query(g) if j != i and geoms[j].area < g.area
                 and g.contains(geoms[j].representative_point())]
        if inner: g = g.difference(unary_union(inner))
        if not g.is_empty: out[s].append(g)
    return {k: make_valid(unary_union(v)) for k, v in out.items()}, to_native, to_lonlat

def km2(g_lonlat):
    fwd, _ = proj(60, -80)
    return transform(fwd, g_lonlat).area / 1e6

def dense_box(x0, y0, x1, y1, n=200):
    xs = np.linspace(x0, x1, n); ys = np.linspace(y0, y1, n)
    ring = [(x, y0) for x in xs] + [(x1, y) for y in ys] + [(x, y1) for x in xs[::-1]] + [(x0, y) for y in ys[::-1]]
    return Polygon(ring)

def hudson(year, slice_name):
    d, to_native, to_lonlat = dyke(slice_name)
    # Area of the land uplift: north of 50° N, east of 125° W, without Greenland (its coast in
    # Dyke's maps is schematic). South of it (Maine, Nova Scotia, the Pacific coast) and on
    # Greenland the differences are between coastlines, not land uplift.
    modern = make_valid(transform(to_native, land_of(-5000, (-170, 40, -20, 84)))).buffer(0)
    green = [p for p in polys(modern) if p.contains(Point(to_native(-42, 72)))]
    reg = transform(to_native, dense_box(-125, 50, -50, 84)).difference(unary_union(green).buffer(30000))
    keep = unary_union([d['ICE'], d['LAND'], d['LAKE']]).intersection(reg)
    # 1) today's land that Dyke has as sea: the drowned lowlands (slivers along the coast removed)
    Fm = modern.intersection(reg).difference(keep)
    Fo = Fm.buffer(-3000).buffer(3000)
    Fo = unary_union([p for p in polys(Fo) if p.area >= MIN_PIECE])
    # 2) the land of the year that Dyke has as sea, next to these lowlands: on map 6000 also
    #    the shelf dry at −20 m in front of them (up to 40 km), elsewhere the −20 m coast stays
    base = modern if year == -5000 else make_valid(transform(to_native, land_of(year, (-170, 40, -20, 84)))).buffer(0)
    F = base.intersection(reg).difference(keep)
    E = F.intersection(Fo.buffer(5000 if year == -5000 else 40000))
    E = unary_union([p for p in polys(E) if p.area >= 1e6])
    E_ll = transform(to_lonlat, E)
    a = km2(E_ll)
    a_modern = km2(transform(to_lonlat, E.intersection(modern)))
    print(f'  Hudson Bay {year} ({slice_name}): {a:,.0f} km² of land under the sea, of it {a_modern:,.0f} km² of today\'s land')
    for p in sorted(polys(Fo), key=lambda p: -p.area)[:8]:
        pl = transform(to_lonlat, p); c = pl.centroid; print(f'     {km2(pl):9,.0f} km² at {c.x:.1f}, {c.y:.1f}')
    # reach 3 km into the sea, so that no hairline of land is left along the coast
    E2 = E.buffer(3000).difference(base.difference(E)).simplify(300)
    return transform(to_lonlat, E2), a, a_modern

def ice(year, slice_name, pick):
    d, to_native, to_lonlat = dyke(slice_name)
    land = make_valid(transform(to_native, land_of(year, (-120, 45, -55, 75)))).buffer(0)
    pieces = []
    for p in polys(d['ICE']):
        pl = transform(to_lonlat, p)
        if pick(pl.centroid.x, pl.centroid.y, km2(pl)): pieces.append(p)
    g = unary_union(pieces).intersection(land)
    g = unary_union([p for p in polys(g) if p.area >= 50e6]).simplify(500)
    gl = transform(to_lonlat, g)
    a = km2(gl)
    print(f'  ice {year} ({slice_name}): {a:,.0f} km²')
    for p in sorted(polys(gl), key=lambda p: -km2(p))[:6]:
        b = p.bounds; print(f'     {km2(p):9,.0f} km², {b[1]:.1f}–{b[3]:.1f}° N, {-b[2]:.1f}–{-b[0]:.1f}° W')
    return gl, a

# --- 3. Head of the Persian Gulf ------------------------------------------------
MESOPOTAMIA = [(47.65,29.95),(47.6,30.4),(47.1,30.6),(46.6,30.85),(46.25,31.0),(46.4,31.3),(46.8,31.65),(47.15,31.9),(47.45,31.75),(47.74,31.46),
               (48.15,31.36),(48.24,31.18),(48.3,30.97),(48.47,30.82),(49.0,30.72),(49.3,30.56),(49.44,30.36),(49.53,30.05),(49.5,29.6),(48.0,29.6),(47.65,29.95)]

if __name__ == '__main__':
    W = 'Western Laurentide: east of 125° W'
    for year, t in ((-5000, 6950), (-6000, 7950)):
        g, a = fennoscandia(year, t)
        write(os.path.join(LAKES, f'sea-fennoscandia-{-year}.geojson'), g, {
            'name': 'Sea on today\'s land: Gulf of Bothnia and Fennoscandia',
            'description': f'Map {-year}{"*" if year == -6000 else ""} (items 5000bc-14, 5000bc-4; 21.11.2026): land below the shoreline of c. {t} cal BP after the shore displacement model of Påsse 2001 (SKB TR-01-41, table 3-1), ETOPO1 10\' grid, pieces < 300 km² dropped; c. {a:,.0f} km² of today\'s land. Generated by tools/sea-inland.py.'})
    for year, sl, t in ((-5000, 'ice6k', '6 ka 14C (c. 6.85 cal ka)'), (-6000, 'ice72k', '7.2 ka 14C (c. 8.0 cal ka)')):
        g, a, am = hudson(year, sl)
        write(os.path.join(LAKES, f'sea-hudson-{-year}.geojson'), g, {
            'name': 'Sea on today\'s land: Hudson Bay (Tyrrell Sea) and the Arctic coast of Canada',
            'description': f'Map {-year}{"*" if year == -6000 else ""} (items 5000bc-15, 5000bc-4; 21.11.2026): land of the year that is neither land, ice nor lake in Dyke et al. 2003 (GSC Open File 1574), slice {t}; north of 50° N, east of 125° W, without Greenland; c. {a:,.0f} km² (of it {am:,.0f} km² of today\'s land). Generated by tools/sea-inland.py.'})
    meso = Polygon(MESOPOTAMIA)
    write(os.path.join(LAKES, 'sea-mesopotamia-5000.geojson'), meso, {
        'name': 'Sea on today\'s land: head of the Persian Gulf',
        'description': 'Map 5000 (items 5000bc-16 a, 5000bc-4; 21.11.2026): the head of the Gulf c. 7000 cal BP — Iran after Heyvaert & Baeteman 2007 (fig. 11b: the coast of c. 7500 and 5000 cal BP), Iraq after Sanlaville & Dalongeville 2005 (fig. 2: the assumed maximum of the transgression through Nasiriya and Amara); approximate. Erased from the land only. Written by tools/sea-inland.py.'})
    # Ice. Map 5000: the Labrador dome (two pieces over northern Quebec) and the Melville Peninsula.
    def pick5000(x, y, a):
        return (-80 < x < -60 and 52 < y < 62) or (-87 < x < -80 and 66 < y < 70.5)
    g, a = ice(-5000, 'ice6k', pick5000)
    write(os.path.join(SHAPES, 'm5-laurentide-ice.geojson'), g, {
        'description': f'Remnants of the Laurentide ice sheet c. 6950 cal BP (map 5000, item 5000bc-17 b, 21.11.2026): ICE of Dyke et al. 2003 (GSC Open File 1574), slice 6 ka 14C (c. 6.85 cal ka) — the Labrador dome over northern Quebec and the ice on the Melville Peninsula; c. {a:,.0f} km² on land. Southampton and Baffin ice lie inside "Uninhabited — Canadian Arctic Archipelago". Generated by tools/sea-inland.py.'})
    # Map 6000: the Labrador dome and the Keewatin–Foxe ice (the two big pieces east of 105° W, south of 73° N)
    def pick6000(x, y, a):
        return -105 < x < -55 and 50 < y < 73 and a > 50000  # km²: drops small ice caps
    g, a = ice(-6000, 'ice72k', pick6000)
    write(os.path.join(SHAPES, 'm6-laurentide.geojson'), g, {
        'description': f'Remnants of the Laurentide ice sheet c. 7950 cal BP (map 6000*, item 6-408 a, 21.11.2026): ICE of Dyke et al. 2003 (GSC Open File 1574), slice 7.2 ka 14C (c. 8.0 cal ka) — the Labrador dome and the Keewatin–Foxe ice (north and west of Hudson Bay, Foxe Basin, Melville Peninsula, southern Baffin Island); c. {a:,.0f} km² on land. No Cordilleran or Alaskan glaciers, no ice caps of the Arctic islands. Generated by tools/sea-inland.py.'})

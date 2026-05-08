// controllers/mango/ParcelaMango.js

const sequelize = require('../../config/database');  // ← correcto: sin llaves
const { QueryTypes } = require('sequelize');

// ─── GET PARCELAS GEOJSON (para MapLibre) ────────────────────────────────────
const obtenerParcelasMangoGeoJSON = async (req, res) => {
    try {
        const userZonaId = req.session?.user?.zona_id;
        const userRol    = req.session?.user?.rol;
        const { zona_id } = req.query;

        // ✅ Usar replacements en lugar de interpolación directa
        const replacements = {};
        let whereExtra = '';

        if (userRol == 3 && userZonaId) {
            whereExtra = 'AND up.zona_id = :zona_id_filtro';
            replacements.zona_id_filtro = parseInt(userZonaId);
        } else if (zona_id) {
            whereExtra = 'AND up.zona_id = :zona_id_filtro';
            replacements.zona_id_filtro = parseInt(zona_id);
        }

        const result = await sequelize.query(
            `SELECT json_build_object(
                'type', 'FeatureCollection',
                'features', COALESCE(json_agg(
                    json_build_object(
                        'type', 'Feature',
                        'geometry', ST_AsGeoJSON(ST_Transform(pm.geom, 4326))::json,
                        'properties', json_build_object(
                            'gid',              pm.gid,
                            'id',               up.id,
                            'nombre',           up.nombre,
                            'codigo',           up.codigo,
                            'productor_nombre', p.nombre,
                            'productor_codigo', p.codigo,
                            'productor_dni',    p.dni,
                            'variedad',         v.nombre,
                            'sello',            s.nombre,
                            'zona',             z.nombre,
                            'zona_id',          up.zona_id,
                            'comite',           co.nombre,
                            'caserio',          ca.nombre,
                            'corredor',         cr.nombre,
                            'area_poly_ha',     up.area_poly_ha,
                            'area_ha_manual',   up.area_ha_manual,
                            'numero_plantas',   up.numero_plantas,
                            'altitud_msnm',     up.altitud_msnm,
                            'codigo_venta',     up.codigo_venta,
                            'activa',           up.activa
                        )
                    )
                ), '[]'::json)
            ) AS geojson
            FROM parcelas_mango pm
            JOIN unidad_productiva up ON pm.gid = up.parcela_gid
            LEFT JOIN productor  p  ON up.productor_id  = p.id
            LEFT JOIN variedad   v  ON up.variedad_id   = v.id
            LEFT JOIN sello      s  ON up.sello_id      = s.id
            LEFT JOIN zona       z  ON up.zona_id       = z.id
            LEFT JOIN comite    co  ON up.comite_id     = co.id
            LEFT JOIN caserio   ca  ON up.caserio_id    = ca.id
            LEFT JOIN corredor  cr  ON up.corredor_id   = cr.id
            WHERE up.activa = '1' AND up.eliminada = '0'
            ${whereExtra}`,
            { replacements, type: QueryTypes.SELECT }
        );

        res.json(result[0].geojson);
    } catch (err) {
        console.error('Error obtenerParcelasMangoGeoJSON:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── CREAR PARCELA DESDE MAPA ────────────────────────────────────────────────
const crearParcelaMango = async (req, res) => {
    try {
        const { nombre, geojson, variedad_id, zona_id, productor_id } = req.body;

        if (!geojson || !zona_id) {
            return res.status(400).json({ error: 'Faltan datos requeridos: geojson, zona_id' });
        }

        const geoStr = typeof geojson === 'object' ? JSON.stringify(geojson) : geojson;

        const result = await sequelize.query(
            `SELECT * FROM mango_crear_parcela(:nombre, :geojson, :variedad_id, :zona_id, :productor_id)`,
            {
                replacements: {
                    nombre:       nombre || 'Nueva Parcela',
                    geojson:      geoStr,
                    variedad_id:  variedad_id  || null,
                    zona_id:      parseInt(zona_id),
                    productor_id: productor_id || null
                },
                type: QueryTypes.SELECT
            }
        );

        res.json({
            success:              true,
            gid:                  result[0].gid_nuevo,
            unidad_productiva_id: result[0].unidad_productiva_id
        });
    } catch (err) {
        console.error('Error crearParcelaMango:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── ACTUALIZAR GEOMETRÍA ────────────────────────────────────────────────────
const actualizarGeometriaParcela = async (req, res) => {
    try {
        const { parcela_gid, geojson } = req.body;

        if (!parcela_gid || !geojson) {
            return res.status(400).json({ error: 'Faltan datos: parcela_gid, geojson' });
        }

        const geoStr = typeof geojson === 'object' ? JSON.stringify(geojson) : geojson;

        await sequelize.query(
            `UPDATE parcelas_mango
             SET geom = ST_SetSRID(ST_Multi(ST_GeomFromGeoJSON(:geojson)), 4326)
             WHERE gid = :gid`,
            {
                replacements: { gid: parseInt(parcela_gid), geojson: geoStr },
                type: QueryTypes.UPDATE
            }
        );

        res.json({ success: true, parcela_gid });
    } catch (err) {
        console.error('Error actualizarGeometriaParcela:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── GET VÉRTICES ────────────────────────────────────────────────────────────
const getVerticesParcela = async (req, res) => {
    try {
        const { gid } = req.query;

        const result = await sequelize.query(
            `SELECT
                ST_AsGeoJSON(geom)::json AS geometry,
                ST_XMin(ST_Envelope(geom)) AS min_lng,
                ST_YMin(ST_Envelope(geom)) AS min_lat,
                ST_XMax(ST_Envelope(geom)) AS max_lng,
                ST_YMax(ST_Envelope(geom)) AS max_lat
             FROM parcelas_mango WHERE gid = :gid`,
            { replacements: { gid: parseInt(gid) }, type: QueryTypes.SELECT }
        );

        if (!result.length) return res.status(404).json({ error: 'Parcela no encontrada' });
        res.json(result[0]);
    } catch (err) {
        console.error('Error getVerticesParcela:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── MVT TILES ──────────────────────────────────────────────────────────────
const mvtTiles = async (req, res) => {
    try {
        const { zona_id, z, x, y } = req.params;

        // ✅ Reemplazado interpolación por replacements
        const replacements = { z: parseInt(z), x: parseInt(x), y: parseInt(y) };
        let zonaFiltro = '';
        if (zona_id !== 'all') {
            zonaFiltro = 'AND up.zona_id = :zona_id';
            replacements.zona_id = parseInt(zona_id);
        }

        const result = await sequelize.query(
            `SELECT ST_AsMVT(tile, 'parcelas_mango', 4096, 'geom') AS mvt
             FROM (
                SELECT
                    pm.gid,
                    up.id           AS up_id,
                    up.nombre,
                    p.nombre        AS productor,
                    v.nombre        AS variedad,
                    up.area_poly_ha,
                    ST_AsMVTGeom(
                        pm.geom,
                        ST_TileEnvelope(:z, :x, :y),
                        4096, 64, true
                    ) AS geom
                FROM parcelas_mango pm
                JOIN unidad_productiva up ON pm.gid = up.parcela_gid
                LEFT JOIN productor p ON up.productor_id = p.id
                LEFT JOIN variedad  v ON up.variedad_id  = v.id
                WHERE up.activa = '1' AND up.eliminada = '0'
                ${zonaFiltro}
                AND pm.geom && ST_TileEnvelope(:z, :x, :y)
             ) AS tile`,
            { replacements, type: QueryTypes.SELECT }
        );

        if (!result[0]?.mvt) return res.status(204).send();

        res.setHeader('Content-Type', 'application/x-protobuf');
        res.send(result[0].mvt);
    } catch (err) {
        console.error('Error mvtTiles:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── CALCULAR INTERSECCIÓN ───────────────────────────────────────────────────
const calcularInterseccion = async (req, res) => {
    try {
        const { geojson } = req.query;
        const geoStr = typeof geojson === 'object' ? JSON.stringify(geojson) : geojson;

        const result = await sequelize.query(
            `SELECT
                COUNT(DISTINCT up.id)::int AS parcelas_intersectadas,
                COALESCE(SUM(
                    ST_Area(ST_Intersection(
                        ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326), 32718),
                        ST_Transform(pm.geom, 32718)
                    ))
                ), 0) AS area_interseccion_m2,
                ST_Area(ST_Transform(
                    ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326), 32718
                )) AS area_nueva_m2
             FROM parcelas_mango pm
             JOIN unidad_productiva up ON pm.gid = up.parcela_gid
             WHERE ST_Intersects(
                ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326), pm.geom
             )
             AND up.activa = '1' AND up.eliminada = '0'`,
            { replacements: { geojson: geoStr }, type: QueryTypes.SELECT }
        );

        res.json(result[0]);
    } catch (err) {
        console.error('Error calcularInterseccion:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── NDVI PROMEDIO POR PARCELA ───────────────────────────────────────────────
const obtenerNdviParcela = async (req, res) => {
    try {
        const { gid } = req.params;

        const result = await sequelize.query(
            // ✅ Agregado filtro por indice = 'NDVI'
            `SELECT AVG((stats).mean) AS ndvi
             FROM (
                SELECT ST_SummaryStats(
                    ST_Clip(
                        r.rast,
                        ST_Transform(p.geom, ST_SRID(r.rast)),
                        true
                    ), 1, true
                ) AS stats
                FROM raster_indice r
                JOIN parcelas_mango p
                    ON ST_Intersects(r.rast, ST_Transform(p.geom, ST_SRID(r.rast)))
                WHERE p.gid = :gid
                  AND r.indice = 'NDVI'
             ) foo`,
            { replacements: { gid: parseInt(gid) }, type: QueryTypes.SELECT }
        );

        res.json({ ndvi: result[0]?.ndvi || 0 });
    } catch (err) {
        console.error('Error NDVI real:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── ELIMINAR PARCELA (soft delete) ─────────────────────────────────────────
const eliminarParcela = async (req, res) => {
    try {
        const { gid } = req.params;

        // ✅ Verificar que la parcela exista antes de eliminar
        const [, meta] = await sequelize.query(
            `UPDATE unidad_productiva
             SET eliminada = '1'
             WHERE parcela_gid = :gid AND eliminada = '0'`,
            { replacements: { gid: parseInt(gid) }, type: QueryTypes.UPDATE }
        );

        if (meta === 0) {
            return res.status(404).json({ error: 'Parcela no encontrada o ya eliminada' });
        }

        res.json({ success: true });
    } catch (err) {
        console.error('Error eliminarParcela:', err);
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    obtenerParcelasMangoGeoJSON,
    crearParcelaMango,
    actualizarGeometriaParcela,
    getVerticesParcela,
    mvtTiles,
    calcularInterseccion,
    obtenerNdviParcela,
    eliminarParcela
};
// controllers/mango/VueloUavController.js
// Gestión de vuelos UAV y rasters de GeoServer
// Ruta desde index.js: require('./controllers/mango/VueloUavController')

const sequelize = require('../../config/database');
const { QueryTypes } = require('sequelize');

// ─── LISTAR TODOS LOS VUELOS ─────────────────────────────────────────────────
const getAllVuelos = async (req, res) => {
    try {
        const result = await sequelize.query(
            `SELECT
                v.id, v.codigo, v.nombre, v.fecha_vuelo,
                v.hora_inicio, v.hora_fin, v.altitud_vuelo_m,
                v.tipo_sensor, v.modelo_dron, v.piloto,
                v.condicion_clima, v.procesado, v.observaciones,
                v.zona_id, z.nombre AS zona_nombre,
                COUNT(DISTINCT r.id)::int AS total_rasters
             FROM vuelo_uav v
             LEFT JOIN zona z ON v.zona_id = z.id
             LEFT JOIN raster_indice r ON r.vuelo_id = v.id
             GROUP BY v.id, z.nombre
             ORDER BY v.fecha_vuelo DESC`,
            { type: QueryTypes.SELECT }
        );
        res.json(result);
    } catch (err) {
        console.error('Error getAllVuelos:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── OBTENER VUELO POR ID CON SUS RASTERS ────────────────────────────────────
const getVueloById = async (req, res) => {
    try {
        const { id } = req.params;

        const result = await sequelize.query(
            `SELECT
                v.*,
                z.nombre AS zona_nombre,
                COALESCE(json_agg(
                    json_build_object(
                        'id',            r.id,
                        'indice',        r.indice,
                        'layer_name',    r.layer_name,
                        'wms_url',       r.wms_url,
                        'workspace',     r.workspace,
                        'resolucion_cm', r.resolucion_cm,
                        'min_valor',     r.min_valor,
                        'max_valor',     r.max_valor
                    )
                ) FILTER (WHERE r.id IS NOT NULL), '[]') AS rasters
             FROM vuelo_uav v
             LEFT JOIN zona z ON v.zona_id = z.id
             LEFT JOIN raster_indice r ON r.vuelo_id = v.id
             WHERE v.id = :id
             GROUP BY v.id, z.nombre`,
            { replacements: { id: parseInt(id) }, type: QueryTypes.SELECT }
        );

        if (!result.length) return res.status(404).json({ error: 'Vuelo no encontrado' });
        res.json(result[0]);
    } catch (err) {
        console.error('Error getVueloById:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── CREAR VUELO ─────────────────────────────────────────────────────────────
const createVuelo = async (req, res) => {
    try {
        const {
            codigo, nombre, zona_id, fecha_vuelo,
            hora_inicio, hora_fin, altitud_vuelo_m,
            solapamiento_lateral, solapamiento_frontal,
            tipo_sensor, modelo_dron, piloto,
            condicion_clima, observaciones
        } = req.body;

        const result = await sequelize.query(
            `INSERT INTO vuelo_uav (
                codigo, nombre, zona_id, fecha_vuelo,
                hora_inicio, hora_fin, altitud_vuelo_m,
                solapamiento_lateral, solapamiento_frontal,
                tipo_sensor, modelo_dron, piloto,
                condicion_clima, observaciones
             ) VALUES (
                :codigo, :nombre, :zona_id, :fecha_vuelo,
                :hora_inicio, :hora_fin, :altitud_vuelo_m,
                :solapamiento_lateral, :solapamiento_frontal,
                :tipo_sensor, :modelo_dron, :piloto,
                :condicion_clima, :observaciones
             ) RETURNING *`,
            {
                replacements: {
                    codigo:               codigo || null,
                    nombre:               nombre || null,
                    zona_id:              zona_id || null,
                    fecha_vuelo,
                    hora_inicio:          hora_inicio          || null,
                    hora_fin:             hora_fin             || null,
                    altitud_vuelo_m:      altitud_vuelo_m      || null,
                    solapamiento_lateral: solapamiento_lateral || null,
                    solapamiento_frontal: solapamiento_frontal || null,
                    tipo_sensor:          tipo_sensor          || 'MULTIESPECTRAL',
                    modelo_dron:          modelo_dron          || null,
                    piloto:               piloto               || null,
                    condicion_clima:      condicion_clima      || null,
                    observaciones:        observaciones        || null
                },
                type: QueryTypes.INSERT
            }
        );
        res.json({ success: true, data: result[0][0] });
    } catch (err) {
        console.error('Error createVuelo:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── ACTUALIZAR VUELO ────────────────────────────────────────────────────────
const updateVuelo = async (req, res) => {
    try {
        const {
            id, codigo, nombre, zona_id, fecha_vuelo,
            hora_inicio, hora_fin, altitud_vuelo_m,
            tipo_sensor, modelo_dron, piloto,
            condicion_clima, observaciones, procesado
        } = req.body;

        await sequelize.query(
            `UPDATE vuelo_uav SET
                codigo          = :codigo,
                nombre          = :nombre,
                zona_id         = :zona_id,
                fecha_vuelo     = :fecha_vuelo,
                hora_inicio     = :hora_inicio,
                hora_fin        = :hora_fin,
                altitud_vuelo_m = :altitud_vuelo_m,
                tipo_sensor     = :tipo_sensor,
                modelo_dron     = :modelo_dron,
                piloto          = :piloto,
                condicion_clima = :condicion_clima,
                observaciones   = :observaciones,
                procesado       = :procesado
             WHERE id = :id`,
            {
                replacements: {
                    id: parseInt(id),
                    codigo, nombre, zona_id, fecha_vuelo,
                    hora_inicio:     hora_inicio     || null,
                    hora_fin:        hora_fin        || null,
                    altitud_vuelo_m: altitud_vuelo_m || null,
                    tipo_sensor:     tipo_sensor     || 'MULTIESPECTRAL',
                    modelo_dron:     modelo_dron     || null,
                    piloto:          piloto          || null,
                    condicion_clima: condicion_clima || null,
                    observaciones:   observaciones   || null,
                    procesado:       procesado       || '0'
                },
                type: QueryTypes.UPDATE
            }
        );
        res.json({ success: true });
    } catch (err) {
        console.error('Error updateVuelo:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── REGISTRAR RASTER DE GEOSERVER ──────────────────────────────────────────
// Se llama después de publicar el raster en GeoServer
const registrarRaster = async (req, res) => {
    try {
        const {
            vuelo_id, indice, nombre_archivo,
            workspace, store, layer_name, wms_url,
            resolucion_cm, epsg, min_valor, max_valor
        } = req.body;

        const result = await sequelize.query(
            `INSERT INTO raster_indice (
                vuelo_id, indice, nombre_archivo,
                workspace, store, layer_name, wms_url,
                resolucion_cm, epsg, min_valor, max_valor
             ) VALUES (
                :vuelo_id, :indice, :nombre_archivo,
                :workspace, :store, :layer_name, :wms_url,
                :resolucion_cm, :epsg, :min_valor, :max_valor
             ) RETURNING *`,
            {
                replacements: {
                    vuelo_id:      parseInt(vuelo_id),
                    indice,
                    nombre_archivo: nombre_archivo || null,
                    workspace:     workspace  || 'mango',
                    store:         store      || null,
                    layer_name,
                    wms_url,
                    resolucion_cm: resolucion_cm || null,
                    epsg:          epsg          || 32718,
                    min_valor:     min_valor     || null,
                    max_valor:     max_valor     || null
                },
                type: QueryTypes.INSERT
            }
        );
        res.json({ success: true, data: result[0][0] });
    } catch (err) {
        console.error('Error registrarRaster:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── RASTERS POR VUELO ───────────────────────────────────────────────────────
const getRastersPorVuelo = async (req, res) => {
    try {
        const { vuelo_id } = req.query;

        const result = await sequelize.query(
            `SELECT r.*, v.fecha_vuelo, v.codigo AS vuelo_codigo
             FROM raster_indice r
             JOIN vuelo_uav v ON r.vuelo_id = v.id
             WHERE r.vuelo_id = :vuelo_id
             ORDER BY r.indice`,
            { replacements: { vuelo_id: parseInt(vuelo_id) }, type: QueryTypes.SELECT }
        );
        res.json(result);
    } catch (err) {
        console.error('Error getRastersPorVuelo:', err);
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    getAllVuelos,
    getVueloById,
    createVuelo,
    updateVuelo,
    registrarRaster,
    getRastersPorVuelo
};
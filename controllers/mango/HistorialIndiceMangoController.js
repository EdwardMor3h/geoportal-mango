// controllers/mango/HistorialIndiceMangoController.js
// Equivalente a HistorialIndiceParcelaCafeController pero para UAV + GeoServer
// Ruta desde index.js: require('./controllers/mango/HistorialIndiceMangoController')

const sequelize = require('../../config/database');
const { QueryTypes } = require('sequelize');

// ─── REGISTRAR ÍNDICE (resultado estadísticas zonales PostGIS/GeoServer) ─────
const registrarIndice = async (req, res) => {
    try {
        const {
            unidad_productiva_id, vuelo_id, raster_id,
            indice, fecha_vuelo,
            valor_min, valor_max, valor_promedio,
            valor_mediana, desviacion_std,
            area_analizada_ha, porcentaje_cobertura,
            geojson
        } = req.body;

        const result = await sequelize.query(
            `SELECT mango_registrar_indice(
                :up_id, :vuelo_id, :raster_id, :indice, :fecha_vuelo,
                :min, :max, :promedio, :mediana, :std, :area_ha, :geojson
             ) AS id`,
            {
                replacements: {
                    up_id:     parseInt(unidad_productiva_id),
                    vuelo_id:  parseInt(vuelo_id),
                    raster_id: raster_id ? parseInt(raster_id) : null,
                    indice,
                    fecha_vuelo,
                    min:      valor_min       || null,
                    max:      valor_max       || null,
                    promedio: valor_promedio  || null,
                    mediana:  valor_mediana   || null,
                    std:      desviacion_std  || null,
                    area_ha:  area_analizada_ha || null,
                    geojson:  geojson ? JSON.stringify(geojson) : null
                },
                type: QueryTypes.SELECT
            }
        );
        res.json({ success: true, id: result[0].id });
    } catch (err) {
        console.error('Error registrarIndice:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── FECHAS DE VUELO DISPONIBLES POR PARCELA ─────────────────────────────────
// Equivalente a obtenerFechaIndicePorGid de tu HistorialIndiceParcelaCafeController
const obtenerFechasVueloPorParcela = async (req, res) => {
    try {
        const { gid, indice } = req.query;
        const replacements = { gid: parseInt(gid) };

        let query = `
            SELECT DISTINCT
                h.fecha_vuelo,
                h.vuelo_id,
                v.codigo      AS vuelo_codigo,
                v.tipo_sensor
            FROM historial_indice_parcela_mango h
            JOIN vuelo_uav v ON h.vuelo_id = v.id
            WHERE h.parcela_gid = :gid
        `;

        if (indice) {
            query += ` AND h.indice = :indice`;
            replacements.indice = indice;
        }

        query += ` ORDER BY h.fecha_vuelo DESC`;

        const result = await sequelize.query(query, { replacements, type: QueryTypes.SELECT });
        res.json(result);
    } catch (err) {
        console.error('Error obtenerFechasVueloPorParcela:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── HISTORIAL POR PARCELA + FECHA + ÍNDICE ───────────────────────────────────
// Equivalente a obtenerRegistrosPorGidYFecha
const obtenerHistorialPorParcelaYFecha = async (req, res) => {
    try {
        const { gid, fecha_vuelo, indice } = req.query;

        const result = await sequelize.query(
            `SELECT
                h.id,
                h.unidad_productiva_id,
                h.parcela_gid,
                h.indice,
                h.fecha_vuelo,
                h.valor_min,
                h.valor_max,
                h.valor_promedio,
                h.valor_mediana,
                h.desviacion_std,
                h.area_analizada_ha,
                h.porcentaje_cobertura,
                h.geojson,
                v.codigo     AS vuelo_codigo,
                v.tipo_sensor,
                r.wms_url,
                r.layer_name,
                r.workspace,
                r.min_valor  AS raster_min,
                r.max_valor  AS raster_max
             FROM historial_indice_parcela_mango h
             LEFT JOIN vuelo_uav     v ON h.vuelo_id  = v.id
             LEFT JOIN raster_indice r ON h.raster_id = r.id
             WHERE h.parcela_gid  = :gid
               AND h.fecha_vuelo  = :fecha_vuelo
               AND h.indice       = :indice`,
            {
                replacements: { gid: parseInt(gid), fecha_vuelo, indice },
                type: QueryTypes.SELECT
            }
        );
        res.json(result);
    } catch (err) {
        console.error('Error obtenerHistorialPorParcelaYFecha:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── EVOLUTIVO DE ÍNDICE POR PARCELA (para gráfica ApexCharts) ───────────────
const obtenerEvolutivoIndice = async (req, res) => {
    try {
        const { unidad_productiva_id, indice } = req.query;

        const result = await sequelize.query(
            `SELECT
                fecha_vuelo,
                valor_promedio,
                valor_min,
                valor_max,
                desviacion_std,
                area_analizada_ha
             FROM historial_indice_parcela_mango
             WHERE unidad_productiva_id = :up_id
               AND indice = :indice
             ORDER BY fecha_vuelo ASC`,
            {
                replacements: { up_id: parseInt(unidad_productiva_id), indice },
                type: QueryTypes.SELECT
            }
        );
        res.json(result);
    } catch (err) {
        console.error('Error obtenerEvolutivoIndice:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── ÚLTIMO ÍNDICE DE TODAS LAS PARCELAS (para colorear el mapa) ─────────────
const obtenerUltimoIndiceParcelas = async (req, res) => {
    try {
        const { indice, zona_id } = req.query;
        const replacements = { indice };

        let zonaFiltro = '';
        if (zona_id) {
            zonaFiltro = `AND up.zona_id = :zona_id`;
            replacements.zona_id = parseInt(zona_id);
        }

        const result = await sequelize.query(
            `SELECT
                h.unidad_productiva_id,
                h.parcela_gid,
                h.indice,
                h.fecha_vuelo,
                h.valor_promedio,
                h.valor_min,
                h.valor_max,
                r.wms_url,
                r.layer_name,
                r.workspace,
                up.nombre AS parcela_nombre,
                p.nombre  AS productor_nombre
             FROM v_ultimo_indice_parcela h
             JOIN unidad_productiva up ON h.unidad_productiva_id = up.id
             LEFT JOIN productor p ON up.productor_id = p.id
             LEFT JOIN historial_indice_parcela_mango him
                ON him.unidad_productiva_id = h.unidad_productiva_id
               AND him.indice       = h.indice
               AND him.fecha_vuelo  = h.fecha_vuelo
             LEFT JOIN raster_indice r ON him.raster_id = r.id
             WHERE h.indice = :indice
               AND up.activa = '1' AND up.eliminada = '0'
             ${zonaFiltro}`,
            { replacements, type: QueryTypes.SELECT }
        );
        res.json(result);
    } catch (err) {
        console.error('Error obtenerUltimoIndiceParcelas:', err);
        res.status(500).json({ error: err.message });
    }
};

// ─── WMS URL ACTIVA POR VUELO E ÍNDICE (para MapLibre) ───────────────────────
const obtenerWmsUrl = async (req, res) => {
    try {
        const { vuelo_id, indice } = req.query;

        const result = await sequelize.query(
            `SELECT
                r.id, r.indice, r.layer_name,
                r.workspace, r.wms_url,
                r.min_valor, r.max_valor,
                v.fecha_vuelo
             FROM raster_indice r
             JOIN vuelo_uav v ON r.vuelo_id = v.id
             WHERE r.vuelo_id = :vuelo_id
               AND r.indice   = :indice
             LIMIT 1`,
            {
                replacements: { vuelo_id: parseInt(vuelo_id), indice },
                type: QueryTypes.SELECT
            }
        );

        if (!result.length) return res.status(404).json({ error: 'Capa no encontrada' });
        res.json(result[0]);
    } catch (err) {
        console.error('Error obtenerWmsUrl:', err);
        res.status(500).json({ error: err.message });
    }
};

module.exports = {
    registrarIndice,
    obtenerFechasVueloPorParcela,
    obtenerHistorialPorParcelaYFecha,
    obtenerEvolutivoIndice,
    obtenerUltimoIndiceParcelas,
    obtenerWmsUrl
};
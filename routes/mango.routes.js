const sequelize = require('../config/database');
const { QueryTypes } = require('sequelize');
const express = require('express');
const router = express.Router();

const parcelaMango = require('../controllers/mango/ParcelaMango');
const vueloUavController = require('../controllers/mango/VueloUavController');
const historialIndiceMangoController = require('../controllers/mango/HistorialIndiceMangoController');

// ─────────────────────────────
// PARCELAS
// ─────────────────────────────
router.get('/shapefile', parcelaMango.obtenerParcelasMangoGeoJSON);
router.post('/polygon', parcelaMango.crearParcelaMango);
router.post('/polygon/update', parcelaMango.actualizarGeometriaParcela);
router.get('/vertices', parcelaMango.getVerticesParcela);
router.get('/interseccion', parcelaMango.calcularInterseccion);
router.get('/parcelas', parcelaMango.obtenerParcelasMangoGeoJSON);
router.get('/ndvi/:gid', parcelaMango.obtenerNdviParcela);
router.post('/crear', parcelaMango.crearParcelaMango);
router.delete('/parcela/:gid', parcelaMango.eliminarParcela);

// ─────────────────────────────
// VUELOS UAV
// ─────────────────────────────
router.get('/vuelos', vueloUavController.getAllVuelos);
router.get('/vuelos/:id', vueloUavController.getVueloById);
router.post('/vuelos', vueloUavController.createVuelo);
router.put('/vuelos', vueloUavController.updateVuelo);
router.post('/vuelos/update', vueloUavController.updateVuelo);
router.post('/raster', vueloUavController.registrarRaster);
router.get('/rasters', vueloUavController.getRastersPorVuelo);

// ─────────────────────────────
// ÍNDICES
// ─────────────────────────────
router.post('/indices', historialIndiceMangoController.registrarIndice);
router.get('/indices/fechas', historialIndiceMangoController.obtenerFechasVueloPorParcela);
router.get('/indices/historial', historialIndiceMangoController.obtenerHistorialPorParcelaYFecha);
router.get('/indices/evolutivo', historialIndiceMangoController.obtenerEvolutivoIndice);
router.get('/indices/ultimo', historialIndiceMangoController.obtenerUltimoIndiceParcelas);
router.get('/indices/wms', historialIndiceMangoController.obtenerWmsUrl);

module.exports = router;

// Agregar estas dos rutas en mango.routes.js

// Info de parcela para el popup
// NDVI por parcela para colorear el mapa
router.get('/ndvi-parcelas', async (req, res) => {
    try {
        const result = await sequelize.query(
            `SELECT json_build_object(
                'type', 'FeatureCollection',
                'features', json_agg(json_build_object(
                    'type', 'Feature',
                    'geometry', ST_AsGeoJSON(ST_Transform(pm.geom, 4326))::json,
                    'properties', json_build_object(
                        'gid', pm.gid,
                        'lote', pm.lote,
                        'ndvi', h.valor_promedio,
                        'fecha', h.fecha_vuelo
                    )
                ))
            ) AS geojson
            FROM parcelas_mango pm
            JOIN historial_indice_parcela_mango h ON pm.gid = h.parcela_gid
            WHERE h.indice = 'NDVI'`,
            { type: QueryTypes.SELECT }
        );
        res.json(result[0].geojson);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Búsqueda por DNI
router.get('/parcelas-por-dni', async (req, res) => {
    const { dni } = req.query;
    try {
        const result = await sequelize.query(
            `SELECT json_build_object(
                'type','FeatureCollection',
                'features', COALESCE(json_agg(json_build_object(
                    'type','Feature',
                    'geometry', ST_AsGeoJSON(ST_Transform(pm.geom,4326))::json,
                    'properties', json_build_object(
                        'gid', pm.gid, 'nombre', up.nombre,
                        'area_poly_ha', up.area_poly_ha,
                        'productor_nombre', p.nombre,
                        'productor_dni', p.dni
                    )
                )),'[]'::json)
            ) AS geojson
            FROM parcelas_mango pm
            JOIN unidad_productiva up ON pm.gid = up.parcela_gid
            JOIN productor p ON up.productor_id = p.id
            WHERE p.dni = :dni AND up.eliminada = '0'`,
            { replacements: { dni }, type: QueryTypes.SELECT }
        );
        res.json(result[0].geojson);
    } catch(err) { res.status(500).json({ error: err.message }); }
});
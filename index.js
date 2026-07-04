require('dotenv').config();  // ← SIEMPRE lo primero
console.log('SESSION_SECRET:', process.env.SESSION_SECRET ? '✅ cargado' : '❌ VACÍO');
console.log('DB_NAME:', process.env.DB_NAME ? '✅ cargado' : '❌ VACÍO');

const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const crypto = require('crypto');
const session = require('express-session');
const bodyParser = require('body-parser');
const axios = require('axios');  // ← movido al inicio

const app = express();
const port = process.env.PORT || 3000;

// ─── Variables GeoServer desde .env ─────────────────────────────────────────
const GEOSERVER_URL  = process.env.GEOSERVER_URL;
const GEOSERVER_USER = process.env.GEOSERVER_USER;
const GEOSERVER_PASS = process.env.GEOSERVER_PASS;

// =======================
// CONFIG GENERAL
// =======================
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000'
}));

app.use(session({
    secret: process.env.SESSION_SECRET,  // ← desde .env
    resave: false,
    saveUninitialized: false
}));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');

// =======================
// MULTER
// =======================
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename:    (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage });

// =======================
// DB
// =======================
const sequelize = require('./config/database');
const { QueryTypes } = require('sequelize');

sequelize.authenticate()
    .then(() => console.log('✅ Conectado a PostgreSQL'))
    .catch(err => console.error('❌ Error de conexión:', err));

// =======================
// EARTH ENGINE
// =======================
const { initializeEarthEngine } = require('./utils/earthEngine');
initializeEarthEngine().catch(err => {
    console.error('Earth Engine error:', err);
});

// =======================
// MODELOS
// =======================
const Usuario = require('./models/Usuario');
const Rol     = require('./models/Rol');
const Zona    = require('./models/Zona');

// =======================
// CONTROLADORES
// =======================
const productorController        = require('./controllers/ProductorController');
const unidadProductivaController = require('./controllers/UnidadProductivaController');
const parcelaCafeController      = require('./controllers/ParcelaCafeController');
const generalController          = require('./controllers/GeneralController');
const usuarioController          = require('./controllers/UsuarioController');

// =======================
// MIDDLEWARE DE AUTH
// =======================
const requireAuth = (req, res, next) => {
    if (req.session?.user?.id) return next();
    res.redirect('/');
};

// =======================
// RUTAS MODULARES
// =======================
const mangoRoutes = require('./routes/mango.routes');

// ✅ /mapa-mango ahora protegido con sesión
app.get('/mapa-mango', requireAuth, (req, res) => {
    res.render('mapa-mango', { 
        user: req.session.user,
        mapboxToken: process.env.MAPBOX_TOKEN
    });
});

// ===== DASHBOARD =====
app.get('/dashboard', requireAuth, (req, res) => {
    res.render('dashboard', { user: req.session.user });
});

// ===== PRODUCTORES =====
app.get('/productores', requireAuth, (req, res) => {
    res.render('productores', { user: req.session.user });
});

// ===== REPORTES =====
app.get('/reportes', requireAuth, (req, res) => {
    res.render('reportes', { user: req.session.user });
});

// ===== REPORTE GENERAL =====
app.get('/reporte-general', requireAuth, (req, res) => {
    res.render('reporte-general', { user: req.session.user });
});

// ===== REPORTE PRODUCTOR =====
app.get('/reporte-productor', requireAuth, (req, res) => {
    res.render('reporte-productor', { user: req.session.user });
});


app.use('/api/mango', mangoRoutes);

// =======================
// CSV
// =======================
app.post('/cargar-csv-unidad-productiva',
    upload.single('csvFile'),
    unidadProductivaController.cargarCSVUnidadProductiva
);

// =======================
// VISTAS
// =======================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '/views/login.html'));
});

app.get('/visor', requireAuth, (req, res) => {
    res.render('mapa-indices', { user: req.session.user });
});

// =======================
// AUTH
// =======================
const SessionTokenController = require('./controllers/SessionTokenController');

app.post('/login', async (req, res) => {
    const { username, correo, password } = req.body;
    const userInput = username || correo;

    if (!userInput || !password) {
        return res.status(400).json({ error: 'Faltan datos' });
    }

    try {
        const md5Password = crypto.createHash('md5').update(password).digest('hex');

        const user = await Usuario.findOne({
            where: { usuario: userInput, contrasena: md5Password },
            include: [{ model: Zona }, { model: Rol }]
        });

        if (!user) return res.send('0'); // ← respuesta JSON clara

        await SessionTokenController.revokeAllSessionTokensForUser(user.id);
        const token = SessionTokenController.generateSessionToken();
        await SessionTokenController.saveSessionToken(user.id, token);

        req.session.userToken = token;
        req.session.user = user;

        res.send('1');  // ← antes era res.send('1')

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error interno' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// =======================
// CAFÉ
// =======================
app.get('/get-shapefile', parcelaCafeController.obtenerParcelasCafeGeoJSON);
app.get('/obtener-geojson', generalController.obtenerGeoJSON);

// ===== API DASHBOARD =====
app.get('/api/mango/stats', requireAuth, async (req, res) => {
    try {
        const [productores] = await sequelize.query(
            `SELECT COUNT(DISTINCT p.id) as total FROM productor p`, 
            {type: QueryTypes.SELECT}
        );
        const [parcelas] = await sequelize.query(
            `SELECT COUNT(*) as total FROM parcelas_mango`,
            {type: QueryTypes.SELECT}
        );
        const [vuelos] = await sequelize.query(
            `SELECT COUNT(*) as total FROM vuelo_uav`,
            {type: QueryTypes.SELECT}
        );
        const [ndvi] = await sequelize.query(
            `SELECT AVG(valor_promedio) as promedio, MAX(valor_promedio) as maximo, MIN(valor_promedio) as minimo FROM historial_indice_parcela_mango WHERE indice='NDVI'`,
            {type: QueryTypes.SELECT}
        );
        res.json({ productores: productores.total, parcelas: parcelas.total, vuelos: vuelos.total, ndvi });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// =======================
// GEOSERVER PROXY
// =======================
app.get('/wms-proxy', async (req, res) => {
    try {
        const params = new URLSearchParams(req.query).toString();
        const url = `${GEOSERVER_URL}/wms?${params}`;

        const response = await axios.get(url, {
            auth: { username: GEOSERVER_USER, password: GEOSERVER_PASS },
            responseType: 'arraybuffer'
        });

        res.set('Content-Type', response.headers['content-type']);
        res.send(response.data);
    } catch (err) {
        console.error('Error wms-proxy:', err.message);
        res.status(500).send('Error GeoServer');
    }
});

// ✅ También proxea GetFeatureInfo (usado por el mapa al hacer clic en parcela)
app.get('/wms-feature-info', async (req, res) => {
    try {
        const params = new URLSearchParams(req.query).toString();
        const url = `${GEOSERVER_URL}/mango/wms?${params}`;

        const response = await axios.get(url, {
            auth: { username: GEOSERVER_USER, password: GEOSERVER_PASS }
        });

        res.json(response.data);
    } catch (err) {
        console.error('Error wms-feature-info:', err.message);
        res.status(500).json({ error: 'Error GeoServer' });
    }
});

app.get('/geoserver-capas', async (req, res) => {
    try {
        const url = `${GEOSERVER_URL}/mango/wms?SERVICE=WMS&REQUEST=GetCapabilities`;

        const response = await axios.get(url, {
            auth: { username: GEOSERVER_USER, password: GEOSERVER_PASS }
        });

        res.set('Content-Type', 'application/xml');
        res.send(response.data);
    } catch (err) {
        console.error('Error geoserver-capas:', err.message);
        res.status(500).send('Error GeoServer');
    }
});

// La ruta del proxy
app.get('/thingspeak-proxy', async (req, res) => {
    try {
        const { channel, field, api_key, days } = req.query;
        const end = new Date();
        const start = new Date(end.getTime() - parseInt(days) * 24 * 60 * 60 * 1000);
        const startStr = start.toISOString().slice(0,19).replace('T',' ');
        const endStr = end.toISOString().slice(0,19).replace('T',' ');
        const url = `https://api.thingspeak.com/channels/${channel}/feeds.json?api_key=${api_key}&start=${encodeURIComponent(startStr)}&end=${encodeURIComponent(endStr)}&results=8000`;
        const response = await axios.get(url);
        res.json(response.data);
    } catch (err) {
        console.error('Error ThingSpeak:', err.message);
        res.status(500).json({ error: 'Error al conectar con ThingSpeak' });
    }
});

// =======================
// SERVER
// =======================
const server = app.listen(port, () => {
    console.log(`🚀 Servidor en puerto ${port}`);
});

server.setTimeout(10 * 60 * 1000);
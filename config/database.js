require('dotenv').config();
const { Sequelize } = require('sequelize');
 
const sequelize = new Sequelize(
    process.env.DB_NAME,
    process.env.DB_USER,
    process.env.DB_PASS,
    {
        host:    process.env.DB_HOST || 'localhost',
        port:    parseInt(process.env.DB_PORT) || 5432,
        dialect: 'postgres',
        logging: false,
    }
);
 
module.exports = sequelize;
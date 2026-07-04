import pandas as pd
import numpy as np
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import LeaveOneOut
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
import psycopg2
import joblib
import warnings
warnings.filterwarnings('ignore')

# ===== CONEXIÓN A POSTGIS =====
def get_conn():
    return psycopg2.connect(
        dbname='gis_mango', host='localhost',
        port=5432, user='gis_user', password='123456'
    )

# ===== CARGAR FEATURES =====
query = """
SELECT
    parcela_gid, lote, area_ha,
    ndvi_raster, num_arboles_yolo,
    altura_promedio, ndvi_arboles_promedio,
    rendimiento_kg
FROM vista_features_parcela
WHERE rendimiento_kg IS NOT NULL
"""
conn = get_conn()
df = pd.read_sql(query, conn)
conn.close()

print(f'Parcelas con datos completos: {len(df)}')
print(df.to_string(index=False))

if len(df) < 4:
    print('Necesitas al menos 4 parcelas con rendimiento real.')
    exit()

# ===== FEATURES Y TARGET =====
features = ['area_ha', 'ndvi_raster', 'num_arboles_yolo',
            'altura_promedio', 'ndvi_arboles_promedio']
X = df[features]
y = df['rendimiento_kg']

print(f'\nFeatures: {features}')
print(f'Target: rendimiento_kg')
print(f'Rango rendimiento: {y.min():.0f} - {y.max():.0f} kg')

# ===== LEAVE-ONE-OUT CROSS VALIDATION =====
# Más adecuado para datasets pequeños (8 parcelas)
# Entrena con N-1 parcelas y evalúa en la restante, repitiendo N veces
print('\n===== VALIDACIÓN LEAVE-ONE-OUT (LOO) =====')
loo = LeaveOneOut()
y_real, y_pred_loo, lotes_eval = [], [], []

for train_idx, test_idx in loo.split(X):
    X_tr, X_te = X.iloc[train_idx], X.iloc[test_idx]
    y_tr, y_te = y.iloc[train_idx], y.iloc[test_idx]

    model_loo = RandomForestRegressor(
        n_estimators=200,
        max_depth=None,
        min_samples_split=2,
        random_state=42
    )
    model_loo.fit(X_tr, y_tr)
    pred = model_loo.predict(X_te)[0]
    y_pred_loo.append(pred)
    y_real.append(y_te.values[0])
    lotes_eval.append(df.iloc[test_idx[0]]['lote'])

# Métricas LOO
r2   = r2_score(y_real, y_pred_loo)
mae  = mean_absolute_error(y_real, y_pred_loo)
rmse = np.sqrt(mean_squared_error(y_real, y_pred_loo))
mape = np.mean(np.abs((np.array(y_real) - np.array(y_pred_loo)) / np.array(y_real))) * 100

print(f'R²   (LOO): {r2:.4f}')
print(f'MAE  (LOO): {mae:.2f} kg')
print(f'RMSE (LOO): {rmse:.2f} kg')
print(f'MAPE (LOO): {mape:.2f} %')

# Tabla comparativa real vs predicho
print('\n===== REAL vs PREDICHO (LOO) =====')
df_comp = pd.DataFrame({
    'Lote': lotes_eval,
    'Real (kg)': [int(v) for v in y_real],
    'Predicho (kg)': [round(v, 0) for v in y_pred_loo],
    'Error (kg)': [round(abs(r-p), 0) for r, p in zip(y_real, y_pred_loo)],
    'Error (%)': [round(abs(r-p)/r*100, 1) for r, p in zip(y_real, y_pred_loo)]
})
print(df_comp.to_string(index=False))

# ===== ENTRENAR MODELO FINAL CON TODOS LOS DATOS =====
model_final = RandomForestRegressor(
    n_estimators=200,
    max_depth=None,
    min_samples_split=2,
    random_state=42
)
model_final.fit(X, y)

# ===== IMPORTANCIA DE VARIABLES =====
importancia = pd.DataFrame({
    'Variable': features,
    'Importancia': model_final.feature_importances_,
    'Importancia (%)': (model_final.feature_importances_ * 100).round(1)
}).sort_values('Importancia', ascending=False)

print('\n===== IMPORTANCIA DE VARIABLES =====')
print(importancia.to_string(index=False))

# ===== PREDICCIÓN COMPLETA POR PARCELA =====
conn2 = get_conn()
df_all = pd.read_sql("""
    SELECT parcela_gid, lote, area_ha,
           ndvi_raster, num_arboles_yolo,
           altura_promedio, ndvi_arboles_promedio
    FROM vista_features_parcela
""", conn2)
conn2.close()

df_all['rendimiento_predicho_kg'] = model_final.predict(df_all[features])
df_all['rendimiento_predicho_t_ha'] = (
    df_all['rendimiento_predicho_kg'] / 1000 / df_all['area_ha']
)

print('\n===== PREDICCIONES FINALES POR PARCELA =====')
print(df_all[['lote', 'area_ha',
              'rendimiento_predicho_kg',
              'rendimiento_predicho_t_ha']].to_string(index=False))

# ===== GUARDAR MODELO =====
joblib.dump(model_final, 'modelo_rendimiento_mango.pkl')
print('\n✅ Modelo guardado: modelo_rendimiento_mango.pkl')

# ===== GUARDAR PREDICCIONES EN POSTGIS =====
conn3 = get_conn()
cur = conn3.cursor()
cur.execute("""
    CREATE TABLE IF NOT EXISTS prediccion_rendimiento (
        parcela_gid INTEGER PRIMARY KEY,
        lote VARCHAR,
        area_ha NUMERIC,
        rendimiento_predicho_kg NUMERIC,
        rendimiento_predicho_t_ha NUMERIC,
        r2_modelo NUMERIC,
        mae_modelo NUMERIC,
        rmse_modelo NUMERIC,
        fecha_prediccion TIMESTAMP DEFAULT NOW()
    )
""")
cur.execute("DELETE FROM prediccion_rendimiento")
for _, row in df_all.iterrows():
    cur.execute("""
        INSERT INTO prediccion_rendimiento
        (parcela_gid, lote, area_ha, rendimiento_predicho_kg,
         rendimiento_predicho_t_ha, r2_modelo, mae_modelo, rmse_modelo)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
    """, (
        int(row['parcela_gid']),
        row['lote'],
        float(row['area_ha']),
        round(float(row['rendimiento_predicho_kg']), 2),
        round(float(row['rendimiento_predicho_t_ha']), 4),
        round(float(r2), 4),
        round(float(mae), 2),
        round(float(rmse), 2)
    ))
conn3.commit()
conn3.close()
print('✅ Predicciones guardadas en PostGIS: prediccion_rendimiento')
print(f'\nResumen del modelo Random Forest:')
print(f'  R²: {r2:.4f} | MAE: {mae:.0f} kg | RMSE: {rmse:.0f} kg | MAPE: {mape:.1f}%')
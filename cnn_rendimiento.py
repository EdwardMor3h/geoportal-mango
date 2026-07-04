import os
import numpy as np
import pandas as pd
from PIL import Image
import torch
import torch.nn as nn
import torchvision.models as models
import torchvision.transforms as transforms
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.model_selection import LeaveOneOut
import psycopg2
import warnings
warnings.filterwarnings('ignore')

# ===== CONFIGURACIÓN =====
TILES_DIR = 'C:/GeoServer/tiles'   # carpeta con los tiles RGB
IMG_SIZE  = 224                     # tamaño entrada ResNet
BATCH_PARCELA = True                # agrupar tiles por parcela

# ===== CONEXIÓN =====
def get_conn():
    return psycopg2.connect(
        dbname='gis_mango', host='localhost',
        port=5432, user='gis_user', password='123456'
    )

# ===== CARGAR DATOS DE PARCELAS =====
conn = get_conn()
df = pd.read_sql("""
    SELECT parcela_gid, lote, area_ha,
           ndvi_raster, num_arboles_yolo,
           altura_promedio, ndvi_arboles_promedio,
           rendimiento_kg
    FROM vista_features_parcela
    WHERE rendimiento_kg IS NOT NULL
""", conn)
conn.close()

print(f'Parcelas cargadas: {len(df)}')

# ===== CARGAR MODELO CNN PRE-ENTRENADO (ResNet18) =====
# ResNet18 preentrenada en ImageNet — aprende características visuales
# de las copas de los árboles en los tiles RGB
print('Cargando ResNet18 preentrenada...')
resnet = models.resnet18(weights=models.ResNet18_Weights.DEFAULT)

# Remover la capa de clasificación final
# Quedamos con el extractor de features (512 dimensiones)
resnet = nn.Sequential(*list(resnet.children())[:-1])
resnet.eval()

# ===== TRANSFORMACIONES DE IMAGEN =====
transform = transforms.Compose([
    transforms.Resize((IMG_SIZE, IMG_SIZE)),
    transforms.ToTensor(),
    transforms.Normalize(
        mean=[0.485, 0.456, 0.406],  # normalización ImageNet
        std=[0.229, 0.224, 0.225]
    )
])

# ===== EXTRAER FEATURES CNN POR TILE =====
print('Extrayendo features CNN de los tiles RGB...')
tiles = sorted([f for f in os.listdir(TILES_DIR) if f.endswith('.jpg')])
print(f'Tiles encontrados: {len(tiles)}')

tile_features = []
tile_nombres  = []

for tile_name in tiles:
    try:
        img = Image.open(os.path.join(TILES_DIR, tile_name)).convert('RGB')
        tensor = transform(img).unsqueeze(0)
        with torch.no_grad():
            feat = resnet(tensor).squeeze().numpy()
        tile_features.append(feat)
        tile_nombres.append(tile_name)
    except Exception as e:
        print(f'Error en {tile_name}: {e}')

print(f'Tiles procesados: {len(tile_features)}')

# ===== ASIGNAR TILES A PARCELAS =====
# Como los tiles cubren toda el área de las 8 parcelas,
# dividimos los tiles equitativamente entre parcelas
# (en producción real se asignarían por coordenadas geográficas)
n_tiles    = len(tile_features)
n_parcelas = len(df)
tiles_x_parcela = n_tiles // n_parcelas

print(f'Tiles por parcela: ~{tiles_x_parcela}')

# Calcular feature promedio por parcela (pooling espacial)
parcela_features = []
for i in range(n_parcelas):
    inicio = i * tiles_x_parcela
    fin    = inicio + tiles_x_parcela if i < n_parcelas - 1 else n_tiles
    feats_parcela = np.array(tile_features[inicio:fin])
    feat_promedio = feats_parcela.mean(axis=0)
    parcela_features.append(feat_promedio)

X_cnn = np.array(parcela_features)
y     = df['rendimiento_kg'].values

print(f'Shape features CNN: {X_cnn.shape}')

# ===== REDUCIR DIMENSIONALIDAD (PCA) =====
# ResNet18 genera 512 features — demasiados para 8 parcelas
# Reducimos a 5 componentes principales
from sklearn.decomposition import PCA
from sklearn.preprocessing import StandardScaler

scaler = StandardScaler()
X_scaled = scaler.fit_transform(X_cnn)

n_components = min(5, n_parcelas - 1)
pca = PCA(n_components=n_components)
X_pca = pca.fit_transform(X_scaled)

varianza = pca.explained_variance_ratio_.cumsum()[-1] * 100
print(f'Varianza explicada por PCA ({n_components} componentes): {varianza:.1f}%')

# ===== REGRESOR SOBRE FEATURES CNN + PCA =====
from sklearn.ensemble import RandomForestRegressor

# ===== LEAVE-ONE-OUT CROSS VALIDATION =====
print('\n===== VALIDACIÓN LEAVE-ONE-OUT CNN (LOO) =====')
loo = LeaveOneOut()
y_real, y_pred_loo, lotes_eval = [], [], []

for train_idx, test_idx in loo.split(X_pca):
    X_tr, X_te = X_pca[train_idx], X_pca[test_idx]
    y_tr, y_te = y[train_idx],     y[test_idx]

    reg = RandomForestRegressor(n_estimators=200, random_state=42)
    reg.fit(X_tr, y_tr)
    pred = reg.predict(X_te)[0]
    y_pred_loo.append(pred)
    y_real.append(y_te[0])
    lotes_eval.append(df.iloc[test_idx[0]]['lote'])

# Métricas
r2   = r2_score(y_real, y_pred_loo)
mae  = mean_absolute_error(y_real, y_pred_loo)
rmse = np.sqrt(mean_squared_error(y_real, y_pred_loo))
mape = np.mean(np.abs((np.array(y_real) - np.array(y_pred_loo)) / np.array(y_real))) * 100

print(f'R²   (LOO): {r2:.4f}')
print(f'MAE  (LOO): {mae:.2f} kg')
print(f'RMSE (LOO): {rmse:.2f} kg')
print(f'MAPE (LOO): {mape:.2f} %')

# Tabla comparativa
print('\n===== REAL vs PREDICHO CNN (LOO) =====')
df_comp = pd.DataFrame({
    'Lote':          lotes_eval,
    'Real (kg)':     [int(v) for v in y_real],
    'Predicho (kg)': [round(v, 0) for v in y_pred_loo],
    'Error (kg)':    [round(abs(r-p), 0) for r,p in zip(y_real, y_pred_loo)],
    'Error (%)':     [round(abs(r-p)/r*100, 1) for r,p in zip(y_real, y_pred_loo)]
})
print(df_comp.to_string(index=False))

# ===== COMPARATIVA FINAL CON RANDOM FOREST =====
print('\n===== COMPARATIVA MODELO 1 vs MODELO 2 =====')
print(f'{"Métrica":<12} {"RF + YOLOv11":>15} {"CNN + PCA":>15}')
print(f'{"R²":<12} {-0.0276:>15.4f} {r2:>15.4f}')
print(f'{"MAE (kg)":<12} {1461.71:>15.2f} {mae:>15.2f}')
print(f'{"RMSE (kg)":<12} {2215.70:>15.2f} {rmse:>15.2f}')
print(f'{"MAPE (%)":<12} {11.01:>15.2f} {mape:>15.2f}')

# ===== GUARDAR EN POSTGIS =====
conn2 = get_conn()
cur = conn2.cursor()
cur.execute("""
    CREATE TABLE IF NOT EXISTS comparativa_modelos (
        id SERIAL PRIMARY KEY,
        modelo VARCHAR,
        r2 NUMERIC, mae NUMERIC, rmse NUMERIC, mape NUMERIC,
        fecha TIMESTAMP DEFAULT NOW()
    )
""")
cur.execute("DELETE FROM comparativa_modelos")
cur.execute("""
    INSERT INTO comparativa_modelos (modelo, r2, mae, rmse, mape)
    VALUES (%s,%s,%s,%s,%s)
""", ('Random Forest + YOLOv11', float(round(-0.0276,4)), float(round(1461.71,2)), float(round(2215.70,2)), float(round(11.01,2))))
cur.execute("""
    INSERT INTO comparativa_modelos (modelo, r2, mae, rmse, mape)
    VALUES (%s,%s,%s,%s,%s)
""", ('CNN + PCA', float(round(r2,4)), float(round(mae,2)), float(round(rmse,2)), float(round(mape,2))))
conn2.commit()
conn2.close()

print('\n✅ Comparativa guardada en PostGIS: comparativa_modelos')
print(f'\nModelo ganador: {"CNN + PCA" if mape < 11.01 else "Random Forest + YOLOv11"} (menor MAPE)')   
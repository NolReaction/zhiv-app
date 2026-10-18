# Земля малого масштаба

`land-110m.json` — Natural Earth, слой `ne_110m_land`, масштаб 1:110 млн.
Источник зафиксирован тегом `v5.1.2`:

https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_land.geojson

SHA-256 исходного файла (138 160 байт):
`9e0729ee253ca7d7a5c4ae9395fb1902264c5377c52e224d13dd85010e2835d9`.

Natural Earth публикует географические данные в общественном достоянии:
https://www.naturalearthdata.com/about/terms-of-use/

Включённые 127 полигонов сохраняют исходную геометрию, включая Антарктиду и
острова. Удалены служебные `name`, `crs`, `bbox` и свойства объектов; координаты
округлены до четырёх знаков после запятой. Воспроизводимое преобразование:

```python
import json

def coordinates(value):
    if isinstance(value, (float, int)):
        return round(value, 4)
    return [coordinates(item) for item in value]

source = json.load(open("ne_110m_land.geojson"))
result = {
    "type": "FeatureCollection",
    "features": [{
        "type": "Feature", "properties": {},
        "geometry": {"type": feature["geometry"]["type"],
                     "coordinates": coordinates(feature["geometry"]["coordinates"])},
    } for feature in source["features"]],
}
with open("land-110m.json", "w") as output:
    output.write(json.dumps(result, separators=(",", ":")) + "\n")
```

Файл входит в код лениво открываемой карты. Это опорный силуэт всей Земли,
а не точная береговая линия для прогулки. Единственный GeoJSON-тайл `maxzoom: 0`
остаётся доступным при вращении, временной потере сети и загрузке нового района.
С масштаба 4 загруженные векторные тайлы OpenStreetMap накрывают его точной
геометрией: локально добавленный MVT-слой подложки и вода рендерятся из одного
тайла. Данные провайдера на диске сохраняются без изменения.

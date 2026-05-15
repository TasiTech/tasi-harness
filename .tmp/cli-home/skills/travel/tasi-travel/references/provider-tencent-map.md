# Provider: Tencent Map

## Purpose
Primary provider for map and context retrieval:
- geocoding and reverse geocoding
- weather by adcode
- POI text/nearby search and place detail
- routing and distance matrix

## Key Requirement
Set key before calls:

PowerShell:
```powershell
$env:TENCENT_MAP_KEY = "your_key_here"
```

Bash:
```bash
export TENCENT_MAP_KEY="your_key_here"
```

## Map Query Methods

### Geocoding and Weather
PowerShell geocode:
```powershell
curl.exe -sG "https://apis.map.qq.com/ws/geocoder/v1/" `
	--data-urlencode "address=北京市天安门" `
	--data-urlencode "region=北京" `
	--data-urlencode "key=$env:TENCENT_MAP_KEY"
```

Bash geocode:
```bash
curl -sG "https://apis.map.qq.com/ws/geocoder/v1/" \
	--data-urlencode "address=北京市天安门" \
	--data-urlencode "region=北京" \
	--data-urlencode "key=$TENCENT_MAP_KEY"
```

PowerShell weather two-step:
```powershell
$geo = curl.exe -sG "https://apis.map.qq.com/ws/geocoder/v1/" --data-urlencode "address=北京" --data-urlencode "key=$env:TENCENT_MAP_KEY"
$adc = [regex]::Match($geo, '"adcode":"(\d{6})"').Groups[1].Value
curl.exe -sG "https://apis.map.qq.com/ws/weather/v1/" --data-urlencode "adcode=$adc" --data-urlencode "data_type=all" --data-urlencode "key=$env:TENCENT_MAP_KEY"
```

### POI Search
Text search:
```bash
curl -sG "https://apis.map.qq.com/ws/place/v1/search" \
	--data-urlencode "keyword=博物馆" \
	--data-urlencode "boundary=region(北京,0)" \
	--data-urlencode "page_size=20" \
	--data-urlencode "key=$TENCENT_MAP_KEY"
```

Nearby search:
```bash
curl -sG "https://apis.map.qq.com/ws/place/v1/search" \
	--data-urlencode "keyword=餐厅" \
	--data-urlencode "boundary=nearby(39.9093,116.3974,1000)" \
	--data-urlencode "page_size=20" \
	--data-urlencode "key=$TENCENT_MAP_KEY"
```

Detail by id:
```bash
curl -sG "https://apis.map.qq.com/ws/place/v1/detail" \
	--data-urlencode "id=15103389097764433256" \
	--data-urlencode "key=$TENCENT_MAP_KEY"
```

### Routing and Matrix
Driving:
```bash
curl -sG "https://apis.map.qq.com/ws/direction/v1/driving/" \
	--data-urlencode "from=39.9093,116.3974" \
	--data-urlencode "to=39.9165,116.3971" \
	--data-urlencode "key=$TENCENT_MAP_KEY"
```

Matrix:
```bash
curl -sG "https://apis.map.qq.com/ws/distance/v1/matrix/" \
	--data-urlencode "mode=driving" \
	--data-urlencode "from=39.9093,116.3974;39.9165,116.3971" \
	--data-urlencode "to=39.9087,116.3975" \
	--data-urlencode "key=$TENCENT_MAP_KEY"
```

## Execution Rules
1. Select minimal endpoint set for the task.
2. Validate required params before each call.
3. Keep coordinate order exactly as endpoint requires.
4. Treat status != 0 as API-level failure.
5. Retry transient failures up to 2 times.
6. If still failing, mark degraded and expose uncertainty.
7. Never fabricate output.

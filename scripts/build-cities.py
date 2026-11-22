"""Convert GeoNames cities15000.txt into the compact data/cities.json the travels page uses.

Usage: python3 -I scripts/build-cities.py path/to/cities15000.txt data/cities.json

Source: https://download.geonames.org/export/dump/cities15000.zip (CC BY 4.0, GeoNames).
Each row: [geonameid, name, asciiName or "", countryCode, lat, lng, population].
"""
import json
import sys


def main(src, dst):
    rows = []
    with open(src, encoding="utf-8") as f:
        for line in f:
            c = line.rstrip("\n").split("\t")
            if len(c) < 15 or c[6] != "P":  # populated places only
                continue
            name, ascii_name = c[1], c[2]
            rows.append([
                int(c[0]),
                name,
                "" if ascii_name == name else ascii_name,
                c[8],
                round(float(c[4]), 4),
                round(float(c[5]), 4),
                int(c[14] or 0),
            ])
    rows.sort(key=lambda r: -r[6])
    out = {
        "source": "GeoNames cities15000 (CC BY 4.0, geonames.org)",
        "fields": ["id", "name", "ascii", "cc", "lat", "lng", "pop"],
        "rows": rows,
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(rows)} cities to {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])

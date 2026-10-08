"""Generate the small, offline Azure icon catalog from Microsoft's official SVG archive."""

import json
import re
import sys
import zipfile
from pathlib import Path
from xml.etree import ElementTree


SERVICES = (
    ("app-service", "Azure App Service", "10035-icon-service-App-Services.svg"),
    ("application-gateway", "Azure Application Gateway", "10076-icon-service-Application-Gateways.svg"),
    ("waf-policy", "Azure Web Application Firewall policy", "10362-icon-service-Web-Application-Firewall-Policies(WAF).svg"),
    ("virtual-network", "Azure Virtual Network", "10061-icon-service-Virtual-Networks.svg"),
    ("private-endpoint", "Azure Private Endpoint", "02579-icon-service-Private-Endpoints.svg"),
    ("sql-database", "Azure SQL Database", "10130-icon-service-SQL-Database.svg"),
    ("key-vault", "Azure Key Vault", "10245-icon-service-Key-Vaults.svg"),
    ("storage-account", "Azure Storage account", "10086-icon-service-Storage-Accounts.svg"),
    ("front-door", "Azure Front Door", "10073-icon-service-Front-Door-and-CDN-Profiles.svg"),
    ("monitor", "Azure Monitor", "00001-icon-service-Monitor.svg"),
)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "core" / "azure-icons.mjs"
SVG_NS = "{http://www.w3.org/2000/svg}"


def icon_svg(source, prefix):
    root = ElementTree.fromstring(source)
    if root.tag != SVG_NS + "svg" or root.get("viewBox") != "0 0 18 18":
        raise ValueError(f"Unexpected SVG root or viewBox for {prefix}")
    ids = set()
    for element in root.iter():
        if element.tag.removeprefix(SVG_NS) not in {
            "svg", "defs", "linearGradient", "radialGradient", "stop", "path",
            "rect", "circle", "ellipse", "polygon", "polyline", "line", "g", "title",
        }:
            raise ValueError(f"Unexpected SVG element in {prefix}: {element.tag}")
        ids.update([element.attrib["id"]] if "id" in element.attrib else [])
        if any(
            (key.endswith("href") and not value.startswith("#")) or key.lower().startswith("on")
            for key, value in element.attrib.items()
        ):
            raise ValueError(f"Unexpected SVG reference or handler in {prefix}")
    svg = source[source.index(">") + 1: source.rindex("</svg>")]
    for old in sorted(ids, key=len, reverse=True):
        new = f"azure-{prefix}-{old}"
        svg = svg.replace(f'id="{old}"', f'id="{new}"')
        svg = svg.replace(f"url(#{old})", f"url(#{new})")
        svg = svg.replace(f'href="#{old}"', f'href="#{new}"')
    if re.search(r"\b(?:url\(|href=|<script\b|<foreignObject\b)", svg, re.I):
        # Only local gradients and paths from the curated archive are allowed.
        remaining = re.sub(r"url\(#[A-Za-z0-9_-]+\)", "", svg)
        remaining = re.sub(r'href="#[A-Za-z0-9_-]+"', "", remaining)
        if re.search(r"\b(?:url\(|href=|<script\b|<foreignObject\b)", remaining, re.I):
            raise ValueError(f"Unexpected resource reference in {prefix}")
    return svg


def main(archive_path):
    with zipfile.ZipFile(archive_path) as archive:
        entries = []
        for service_id, name, filename in SERVICES:
            matches = [path for path in archive.namelist() if path.endswith("/" + filename)]
            if not matches:
                raise ValueError(f"Official icon not found: {filename}")
            svg = icon_svg(archive.read(matches[0]).decode("utf-8-sig"), service_id)
            entries.append({"id": service_id, "name": name, "svg": svg})
    data = json.dumps(entries, ensure_ascii=False, separators=(",", ":"))
    OUTPUT.write_text(
        "// Generated from Microsoft's Azure Public Service Icons V24; do not edit by hand.\n"
        "// Icons are subject to https://learn.microsoft.com/azure/architecture/icons/ (not MIT).\n"
        f"export const AZURE_SERVICES = Object.freeze({data}.map((service) => Object.freeze(service)));\n"
        "const servicesById = new Map(AZURE_SERVICES.map((service) => [service.id, service]));\n"
        "export const AZURE_SERVICE_IDS = Object.freeze(AZURE_SERVICES.map((service) => service.id));\n"
        "export function getAzureService(id) { return servicesById.get(id); }\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: python scripts/update-azure-icons.py <Azure_Public_Service_Icons_V24.zip>")
    main(sys.argv[1])

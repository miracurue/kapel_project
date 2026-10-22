#!/usr/bin/env python3
"""Freeze the approved API description into a compact JSON contract for the tests.

The tests of stage 13 are written before the code. They must not follow the code,
so they read the approved OpenAPI of stage 12, not docs/openapi.yaml that the
developers change. This script turns the YAML into tests/api/contract/operations.json
(one row per operation) so that Node tests need no YAML parser.

Usage:
    python3 tests/tools/build_contract.py [openapi.yaml] [out.json]

Defaults: .agents/web-developer/files/12-architecture/openapi.yaml ->
tests/api/contract/operations.json. Needs PyYAML (only for this script).
A change of the frozen contract is a test change (standards, section 10).
"""
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / ".agents/web-developer/files/12-architecture/openapi.yaml"
OUT = ROOT / "tests/api/contract/operations.json"
ROLE = re.compile(r"^(R-\d{2})\s+[^:]+:\s*([^\s—]+)")


def resolve(doc, node, depth=0):
    if depth > 6 or not isinstance(node, (dict, list)):
        return node
    if isinstance(node, list):
        return [resolve(doc, x, depth + 1) for x in node]
    if "$ref" in node:
        ref = node["$ref"].lstrip("#/").split("/")
        target = doc
        for part in ref:
            target = target[part]
        return resolve(doc, target, depth + 1)
    return {k: resolve(doc, v, depth + 1) for k, v in node.items()}


def main(argv):
    src = Path(argv[0]) if argv else SRC
    out = Path(argv[1]) if len(argv) > 1 else OUT
    doc = yaml.safe_load(src.read_text(encoding="utf-8"))
    ops = []
    for path, item in doc["paths"].items():
        for method, op in item.items():
            if method not in ("get", "post", "put", "patch", "delete"):
                continue
            roles = []
            for r in op.get("x-roles") or []:
                m = ROLE.match(r)
                if m:
                    roles.append({"role": m.group(1), "scope": m.group(2)})
            errors = {}
            for status, resp in (op.get("responses") or {}).items():
                for code in resp.get("x-error-codes") or []:
                    errors.setdefault(code, []).append(int(status))
            body = None
            content = (op.get("requestBody") or {}).get("content") or {}
            if content:
                media, spec = next(iter(content.items()))
                schema = resolve(doc, spec.get("schema") or {})
                body = {"media": media, "required": schema.get("required", []),
                        "properties": sorted((schema.get("properties") or {}).keys())}
            params = []
            for p in op.get("parameters") or []:
                p = resolve(doc, p)
                params.append({"name": p.get("name"), "in": p.get("in"), "required": bool(p.get("required")),
                               "type": (p.get("schema") or {}).get("type")})
            ops.append({
                "method": method.upper(),
                "path": path,
                "operationId": op.get("operationId"),
                "tag": (op.get("tags") or [""])[0],
                "page": op.get("x-page"),
                "functions": op.get("x-functions") or [],
                "roles": roles,
                "permission": op.get("x-permission"),
                "patientAccess": op.get("x-patient-access"),
                "idempotency": op.get("x-idempotency-key"),
                "undo": bool(op.get("x-undo")),
                "crisisGate": bool(op.get("x-crisis-gate")),
                "warnings": op.get("x-warnings") or [],
                "public": op.get("security") == [] or op.get("x-permission") == "public",
                "errors": errors,
                "params": params,
                "body": body,
            })
    out.parent.mkdir(parents=True, exist_ok=True)
    meta = {"source": str(src.relative_to(ROOT)) if src.is_relative_to(ROOT) else str(src),
            "version": doc.get("info", {}).get("version"), "operations": len(ops)}
    out.write_text(json.dumps({"meta": meta, "operations": ops}, ensure_ascii=False, indent=1) + "\n",
                   encoding="utf-8")
    print(f"{out}: {len(ops)} operations")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

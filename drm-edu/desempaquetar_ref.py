#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
desempaquetar_ref.py — Descifrador de REFERENCIA del formato .edu de Edulock.

Su único fin es (1) verificar que el empaquetador produce contenedores válidos
y (2) servir de especificación exacta para el reproductor (web/escritorio).
En producción el mp4 NUNCA se escribe entero a disco: el reproductor descifra
trozo a trozo bajo demanda (ver guía §7). Este script sí lo escribe, solo para test.

Uso:
  python desempaquetar_ref.py entrada.edu salida.mp4 --cek <CEK_HEX>
  python desempaquetar_ref.py entrada.edu salida.mp4 --master <MASTER_HEX> --content-id <id>
"""
import sys, json, struct, hashlib, hmac, argparse
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

MAGIC = b"EDU!"

def hkdf(key, info, n=32):
    return HKDF(algorithm=hashes.SHA256(), length=n, salt=None, info=info).derive(key)

def derive_cek(master_key, salt, content_id):
    return hkdf(master_key, b"edu-cek|" + salt + b"|" + content_id.encode("utf-8"), 32)

def desempaquetar(edu_path, out_path, cek):
    raw = open(edu_path, "rb").read()
    if raw[:4] != MAGIC:
        raise ValueError("magic inválido: no es un .edu")
    # Footer HMAC
    body_all, mac = raw[:-32], raw[-32:]
    expect = hmac.new(hkdf(cek, b"mac"), body_all, hashlib.sha256).digest()
    if not hmac.compare_digest(mac, expect):
        raise ValueError("HMAC inválido — contenedor manipulado o CEK incorrecta")

    off = 4
    version, flags = struct.unpack_from("<HH", raw, off); off += 4
    salt = raw[off:off+16]; off += 16
    (hdr_len,) = struct.unpack_from("<I", raw, off); off += 4
    hdr_ct = raw[off:off+hdr_len]; off += hdr_len
    meta = json.loads(AESGCM(hkdf(cek, b"header")).decrypt(salt[:12], hdr_ct, None).decode("utf-8"))

    cuerpo_ct = body_all[off:]  # hasta el inicio del HMAC
    # Quitar transporte AES-256-CTR
    tkey = hkdf(cek, b"transport")
    dec  = Cipher(algorithms.AES(tkey), modes.CTR(salt[:16])).decryptor()
    cuerpo = dec.update(cuerpo_ct) + dec.finalize()

    # Descifrar trozos
    out = bytearray(); p = 0; idx = 0
    while p < len(cuerpo):
        (clen,) = struct.unpack_from("<I", cuerpo, p); p += 4
        ct = cuerpo[p:p+clen]; p += clen
        sub = hkdf(cek, b"chunk" + struct.pack("<I", idx))
        nonce = salt[:4] + struct.pack("<Q", idx)
        out += AESGCM(sub).decrypt(nonce, ct, None)
        idx += 1

    open(out_path, "wb").write(out)
    sha = hashlib.sha256(out).hexdigest()
    ok = (sha == meta.get("orig_sha256"))
    print(f"OK: {out_path}  ({len(out)} bytes, {idx} trozos)")
    print(f"content_id : {meta.get('content_id')}  key_mode: {meta.get('key_mode')}")
    print(f"sha256 mp4 : {sha}  {'[OK] coincide' if ok else '[X] NO coincide'}")
    return ok

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("edu"); ap.add_argument("out")
    ap.add_argument("--cek"); ap.add_argument("--master"); ap.add_argument("--content-id")
    a = ap.parse_args()
    if a.cek:
        cek = bytes.fromhex(a.cek)
    elif a.master and a.content_id:
        raw = open(a.edu, "rb").read()
        salt = raw[8:24]
        cek = derive_cek(bytes.fromhex(a.master), salt, a.content_id)
    else:
        sys.exit("Da --cek, o --master + --content-id")
    ok = desempaquetar(a.edu, a.out, cek)
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()

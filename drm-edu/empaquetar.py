#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
empaquetar.py — Empaquetador DRM de Edulock (formato .edu)

Sigue el diseño de la guía DRM (AES-256-GCM por trozo de 8 KB + transporte
ChaCha20 + cabecera cifrada + HMAC de integridad), adaptado a Edulock:

  · Clave por video (CEK) DERIVADA de un MASTER_KEY del servidor:
        CEK = HKDF(MASTER_KEY, salt_del_archivo, content_id)
    Así el servidor la re-deriva bajo demanda SIN almacenarla, y cada video
    tiene clave distinta (corrige el "error de clave global fija" del .ipr).
  · El .edu resultante se sube a Bunny; el alumno nunca ve la CEK.
  · El servidor entrega la CEK online por sesión, validando licencia (key_mode
    "online"). Ver server: /api/edu/register y /api/edu/key.

Uso:
  # Modo recomendado (deriva del MASTER_KEY; el servidor re-deriva, no guarda CEK):
  python empaquetar.py entrada.mp4 salida.edu --content-id curso-03-mod3 \\
         --title "Módulo 3" --master <MASTER_KEY_HEX>

  # Modo clave aleatoria (debes registrar la CEK en el servidor):
  python empaquetar.py entrada.mp4 salida.edu --content-id curso-03-mod3 --random
"""
import os, sys, json, struct, hashlib, hmac, argparse
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from cryptography.hazmat.primitives import hashes

MAGIC   = b"EDU!"          # 43 4C 58 21
VERSION = 1
CHUNK   = 8192             # 8 KB, igual que InfoProtector

# Flags
FLAG_ONLINE    = 1 << 0    # solo reproducible pidiendo la clave al servidor
FLAG_WATERMARK = 1 << 1    # el reproductor debe pintar marca de agua

def hkdf(key: bytes, info: bytes, n: int = 32) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=n, salt=None, info=info).derive(key)

def derive_cek(master_key: bytes, salt: bytes, content_id: str) -> bytes:
    # CEK = HKDF(MASTER_KEY, info = salt || content_id)
    return hkdf(master_key, b"edu-cek|" + salt + b"|" + content_id.encode("utf-8"), 32)

def empaquetar(mp4_path: str, out_path: str, cek: bytes, meta: dict) -> dict:
    data = open(mp4_path, "rb").read()
    salt = meta["_salt"]  # ya fijado por el llamador (para derivar CEK)
    meta = {k: v for k, v in meta.items() if not k.startswith("_")}
    meta["orig_sha256"] = hashlib.sha256(data).hexdigest()
    meta["chunk_size"]  = CHUNK
    meta["orig_len"]    = len(data)

    # --- Capa 1: trozos AES-256-GCM con subclave por trozo ---
    cuerpo = bytearray()
    total_chunks = 0
    for i in range(0, len(data), CHUNK):
        trozo = data[i:i+CHUNK]
        idx = i // CHUNK
        sub = hkdf(cek, b"chunk" + struct.pack("<I", idx))
        nonce = salt[:4] + struct.pack("<Q", idx)          # 12 bytes
        ct = AESGCM(sub).encrypt(nonce, trozo, None)        # ct incluye tag (16B)
        cuerpo += struct.pack("<I", len(ct)) + ct
        total_chunks += 1

    # --- Capa 2: transporte AES-256-CTR sobre todo el cuerpo (nativo en WebCrypto) ---
    tkey = hkdf(cek, b"transport")           # 32 bytes
    tiv  = salt[:16]                          # contador inicial de 128 bits
    enc  = Cipher(algorithms.AES(tkey), modes.CTR(tiv)).encryptor()
    cuerpo = enc.update(bytes(cuerpo)) + enc.finalize()

    # --- Cabecera cifrada (AES-256-GCM) ---
    meta["total_chunks"] = total_chunks
    hkey = hkdf(cek, b"header")
    hjson = json.dumps(meta, ensure_ascii=False).encode("utf-8")
    hdr = AESGCM(hkey).encrypt(salt[:12], hjson, None)

    # --- Ensamblar contenedor ---
    out = bytearray()
    out += MAGIC + struct.pack("<HH", VERSION, meta.get("flags", 0))
    out += salt + struct.pack("<I", len(hdr)) + hdr + cuerpo

    # --- HMAC-SHA256 final de integridad ---
    mac = hmac.new(hkdf(cek, b"mac"), bytes(out), hashlib.sha256).digest()
    out += mac
    open(out_path, "wb").write(out)
    return {"bytes": len(out), "chunks": total_chunks, "sha256_mp4": meta["orig_sha256"]}

def main():
    ap = argparse.ArgumentParser(description="Empaquetador DRM Edulock (.edu)")
    ap.add_argument("mp4"); ap.add_argument("out")
    ap.add_argument("--content-id", required=True)
    ap.add_argument("--title", default="")
    ap.add_argument("--master", help="MASTER_KEY en hex (modo derivado, recomendado)")
    ap.add_argument("--random", action="store_true", help="CEK aleatoria (debes registrarla)")
    ap.add_argument("--watermark", default="buyer:{ID_COMPRADOR}")
    a = ap.parse_args()

    salt = os.urandom(16)
    flags = FLAG_ONLINE | FLAG_WATERMARK
    if a.random or not a.master:
        cek = os.urandom(32)
        mode = "random"
    else:
        cek = derive_cek(bytes.fromhex(a.master), salt, a.content_id)
        mode = "derived"

    meta = {
        "content_id": a.content_id, "title": a.title,
        "key_mode": "online", "key_ref": a.content_id,
        "watermark": a.watermark, "flags": flags,
        "_salt": salt,
    }
    info = empaquetar(a.mp4, a.out, cek, meta)
    print(f"OK: {a.out}  ({info['bytes']} bytes, {info['chunks']} trozos)")
    print(f"content_id : {a.content_id}")
    print(f"salt       : {salt.hex()}")
    print(f"key_mode   : online ({mode})")
    if mode == "derived":
        print("Registrar en el servidor (NO lleva la clave — el server la re-deriva del MASTER_KEY):")
        print(f'  POST /api/edu/register  {{"contentId":"{a.content_id}","salt":"{salt.hex()}","bunnyUrl":"<url del .edu en Bunny>"}}')
    else:
        print("CEK aleatoria — súbela al servidor (indexada por content_id):")
        print(f"  CEK: {cek.hex()}")

if __name__ == "__main__":
    main()

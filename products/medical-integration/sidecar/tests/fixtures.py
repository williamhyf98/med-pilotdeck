"""Artificial, non-PHI binary fixtures generated entirely in tests."""

from __future__ import annotations

import struct
from typing import Iterable, Sequence


def npy_bytes(shape: Sequence[int], values: Iterable[float], dtype: str = "<f4") -> bytes:
    value_list = list(values)
    count = 1
    for item in shape:
        count *= item
    if count != len(value_list):
        raise ValueError("fixture value count does not match shape")
    header_dict = {
        "descr": dtype,
        "fortran_order": False,
        "shape": tuple(shape),
    }
    header = repr(header_dict).encode("latin1")
    prefix_length = 10
    padding = (16 - ((prefix_length + len(header) + 1) % 16)) % 16
    header += b" " * padding + b"\n"
    if len(header) > 65535:
        raise ValueError("fixture header is too large")
    payload = b"".join(struct.pack("<f", float(value)) for value in value_list)
    return b"\x93NUMPY\x01\x00" + struct.pack("<H", len(header)) + header + payload


def minimal_pdf_bytes(text: str = "Synthetic medical fixture") -> bytes:
    escaped = text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    stream = f"BT /F1 12 Tf 20 100 Td ({escaped}) Tj ET\n".encode("latin1")
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        b"<< /Length "
        + str(len(stream)).encode("ascii")
        + b" >>\nstream\n"
        + stream
        + b"endstream",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]
    output = bytearray(b"%PDF-1.4\n")
    offsets = [0]
    for index, body in enumerate(objects, start=1):
        offsets.append(len(output))
        output.extend(f"{index} 0 obj\n".encode("ascii"))
        output.extend(body)
        output.extend(b"\nendobj\n")
    xref = len(output)
    output.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    output.extend(
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode(
            "ascii"
        )
    )
    return bytes(output)


def minimal_dicom_bytes() -> bytes:
    sop_class = "1.2.840.10008.5.1.4.1.1.2"
    sop_instance = "1.2.826.0.1.3680043.10.999.1"
    transfer_syntax = "1.2.840.10008.1.2.1"
    implementation = "1.2.826.0.1.3680043.10.999"

    meta_without_length = b"".join(
        [
            _dicom_element(0x0002, 0x0001, "OB", b"\x00\x01"),
            _dicom_element(0x0002, 0x0002, "UI", _text_value(sop_class, "UI")),
            _dicom_element(0x0002, 0x0003, "UI", _text_value(sop_instance, "UI")),
            _dicom_element(0x0002, 0x0010, "UI", _text_value(transfer_syntax, "UI")),
            _dicom_element(0x0002, 0x0012, "UI", _text_value(implementation, "UI")),
        ]
    )
    meta = _dicom_element(0x0002, 0x0000, "UL", struct.pack("<I", len(meta_without_length)))
    meta += meta_without_length
    dataset = b"".join(
        [
            _dicom_element(0x0008, 0x0016, "UI", _text_value(sop_class, "UI")),
            _dicom_element(0x0008, 0x0018, "UI", _text_value(sop_instance, "UI")),
            _dicom_element(0x0008, 0x0060, "CS", _text_value("CT", "CS")),
            _dicom_element(0x0010, 0x0010, "PN", _text_value("SYNTHETIC^TEST", "PN")),
            _dicom_element(0x0010, 0x0020, "LO", _text_value("SYNTHETIC-ID", "LO")),
            _dicom_element(0x0028, 0x0002, "US", struct.pack("<H", 1)),
            _dicom_element(0x0028, 0x0004, "CS", _text_value("MONOCHROME2", "CS")),
            _dicom_element(0x0028, 0x0010, "US", struct.pack("<H", 2)),
            _dicom_element(0x0028, 0x0011, "US", struct.pack("<H", 2)),
            _dicom_element(0x0028, 0x0100, "US", struct.pack("<H", 16)),
            _dicom_element(0x0028, 0x0101, "US", struct.pack("<H", 12)),
            _dicom_element(0x0028, 0x0102, "US", struct.pack("<H", 11)),
            _dicom_element(0x0028, 0x0103, "US", struct.pack("<H", 0)),
            _dicom_element(0x7FE0, 0x0010, "OW", struct.pack("<4H", 0, 100, 500, 1000)),
        ]
    )
    return b"\x00" * 128 + b"DICM" + meta + dataset


def _text_value(value: str, vr: str) -> bytes:
    raw = value.encode("ascii")
    if len(raw) % 2:
        raw += b"\x00" if vr == "UI" else b" "
    return raw


def _dicom_element(group: int, element: int, vr: str, value: bytes) -> bytes:
    long_vr = vr in {"OB", "OD", "OF", "OL", "OW", "SQ", "UC", "UR", "UT", "UN"}
    prefix = struct.pack("<HH", group, element) + vr.encode("ascii")
    if long_vr:
        return prefix + b"\x00\x00" + struct.pack("<I", len(value)) + value
    return prefix + struct.pack("<H", len(value)) + value


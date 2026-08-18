"""Small, safe NPY reader for numeric C-order arrays.

It exists so artifact validation and small offline fixtures do not require
NumPy. The reader rejects object arrays, structured dtypes, Fortran order and
truncated payloads. Large file-backed matrices are read row-by-row.
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
import io
import math
from pathlib import Path
import re
import struct
from typing import BinaryIO, Iterator


_DTYPE_RE = re.compile(r"^([<>=|])([fiub])(\d+)$")
_STRUCT_CODES = {
    ("f", 2): "e",
    ("f", 4): "f",
    ("f", 8): "d",
    ("i", 1): "b",
    ("i", 2): "h",
    ("i", 4): "i",
    ("i", 8): "q",
    ("u", 1): "B",
    ("u", 2): "H",
    ("u", 4): "I",
    ("u", 8): "Q",
    ("b", 1): "?",
}


@dataclass(frozen=True)
class NpyHeader:
    version: tuple[int, int]
    dtype: str
    shape: tuple[int, ...]
    item_size: int
    data_offset: int
    item_count: int
    payload_bytes: int


class NpyArray:
    def __init__(self, header: NpyHeader, *, data: bytes | None = None, path: Path | None = None):
        if (data is None) == (path is None):
            raise ValueError("exactly one NPY source is required")
        self.header = header
        self._data = data
        self._path = path

    @classmethod
    def from_bytes(
        cls,
        data: bytes,
        *,
        max_items: int,
        max_dimensions: int = 4,
    ) -> "NpyArray":
        stream = io.BytesIO(data)
        header = _read_header(stream, max_items=max_items, max_dimensions=max_dimensions)
        if len(data) != header.data_offset + header.payload_bytes:
            raise ValueError("NPY payload size does not match shape and dtype")
        return cls(header, data=data)

    @classmethod
    def from_path(
        cls,
        path: str | Path,
        *,
        max_items: int,
        max_dimensions: int = 4,
    ) -> "NpyArray":
        resolved = Path(path).resolve(strict=True)
        with resolved.open("rb") as stream:
            header = _read_header(stream, max_items=max_items, max_dimensions=max_dimensions)
        if resolved.stat().st_size != header.data_offset + header.payload_bytes:
            raise ValueError("NPY payload size does not match shape and dtype")
        return cls(header, path=resolved)

    @property
    def shape(self) -> tuple[int, ...]:
        return self.header.shape

    @property
    def dtype(self) -> str:
        return self.header.dtype

    def read_flat(self, start: int, count: int) -> tuple[float, ...]:
        if start < 0 or count < 0 or start + count > self.header.item_count:
            raise ValueError("NPY read range is outside the array")
        if count == 0:
            return ()
        byte_start = self.header.data_offset + start * self.header.item_size
        raw = self._read_bytes(byte_start, count * self.header.item_size)
        fmt = _struct_format(self.header.dtype)
        values = tuple(float(item[0]) for item in struct.iter_unpack(fmt, raw))
        if len(values) != count or any(not math.isfinite(value) for value in values):
            raise ValueError("NPY contains non-finite or incomplete numeric data")
        return values

    def read_row(self, index: int) -> tuple[float, ...]:
        if len(self.shape) != 2:
            raise ValueError("NPY array is not a matrix")
        rows, columns = self.shape
        if not 0 <= index < rows:
            raise ValueError("NPY row index is outside the matrix")
        return self.read_flat(index * columns, columns)

    def iter_rows(self) -> Iterator[tuple[float, ...]]:
        if len(self.shape) != 2:
            raise ValueError("NPY array is not a matrix")
        rows, columns = self.shape
        row_bytes = columns * self.header.item_size
        fmt = _struct_format(self.header.dtype)
        if self._data is not None:
            stream: BinaryIO = io.BytesIO(self._data)
            close_stream = True
        else:
            assert self._path is not None
            stream = self._path.open("rb")
            close_stream = True
        try:
            stream.seek(self.header.data_offset)
            for _ in range(rows):
                raw = stream.read(row_bytes)
                if len(raw) != row_bytes:
                    raise ValueError("NPY payload is truncated")
                values = tuple(float(item[0]) for item in struct.iter_unpack(fmt, raw))
                if any(not math.isfinite(value) for value in values):
                    raise ValueError("NPY contains non-finite numeric data")
                yield values
        finally:
            if close_stream:
                stream.close()

    def read_depth_slice(self, index: int) -> tuple[float, ...]:
        if len(self.shape) != 3:
            raise ValueError("NPY array is not a 3D volume")
        depth, height, width = self.shape
        if not 0 <= index < depth:
            raise ValueError("NPY depth index is outside the volume")
        return self.read_flat(index * height * width, height * width)

    def sampled_values(self, maximum: int = 200_000) -> tuple[float, ...]:
        if maximum <= 0:
            return ()
        count = self.header.item_count
        if count <= maximum:
            return self.read_flat(0, count)
        step = max(1, count // maximum)
        indices = range(0, count, step)
        if self._data is not None:
            return tuple(self.read_flat(index, 1)[0] for index in indices)
        values: list[float] = []
        assert self._path is not None
        fmt = _struct_format(self.header.dtype)
        with self._path.open("rb") as stream:
            for index in indices:
                stream.seek(self.header.data_offset + index * self.header.item_size)
                raw = stream.read(self.header.item_size)
                if len(raw) != self.header.item_size:
                    raise ValueError("NPY payload is truncated")
                value = float(struct.unpack(fmt, raw)[0])
                if not math.isfinite(value):
                    raise ValueError("NPY contains non-finite numeric data")
                values.append(value)
        return tuple(values)

    def _read_bytes(self, offset: int, length: int) -> bytes:
        if self._data is not None:
            raw = self._data[offset : offset + length]
        else:
            assert self._path is not None
            with self._path.open("rb") as stream:
                stream.seek(offset)
                raw = stream.read(length)
        if len(raw) != length:
            raise ValueError("NPY payload is truncated")
        return raw


def _read_header(
    stream: BinaryIO,
    *,
    max_items: int,
    max_dimensions: int,
) -> NpyHeader:
    if stream.read(6) != b"\x93NUMPY":
        raise ValueError("file is not an NPY artifact")
    version_raw = stream.read(2)
    if len(version_raw) != 2:
        raise ValueError("NPY version header is truncated")
    version = (version_raw[0], version_raw[1])
    if version == (1, 0):
        length_raw = stream.read(2)
        length_format = "<H"
        encoding = "latin1"
    elif version in {(2, 0), (3, 0)}:
        length_raw = stream.read(4)
        length_format = "<I"
        encoding = "utf-8" if version == (3, 0) else "latin1"
    else:
        raise ValueError(f"unsupported NPY version: {version}")
    if len(length_raw) != struct.calcsize(length_format):
        raise ValueError("NPY header length is truncated")
    header_length = struct.unpack(length_format, length_raw)[0]
    if header_length <= 0 or header_length > 1_048_576:
        raise ValueError("NPY header length is outside the safe range")
    header_raw = stream.read(header_length)
    if len(header_raw) != header_length:
        raise ValueError("NPY header is truncated")
    try:
        body = ast.literal_eval(header_raw.decode(encoding).strip())
    except (SyntaxError, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("NPY header is invalid") from exc
    if not isinstance(body, dict):
        raise ValueError("NPY header must be an object")
    if body.get("fortran_order") is not False:
        raise ValueError("Fortran-order NPY arrays are unsupported")
    dtype = body.get("descr")
    shape = body.get("shape")
    if not isinstance(dtype, str):
        raise ValueError("structured or object NPY dtypes are unsupported")
    item_size = _item_size(dtype)
    if (
        not isinstance(shape, tuple)
        or not 1 <= len(shape) <= max_dimensions
        or any(type(item) is not int or item <= 0 for item in shape)
    ):
        raise ValueError("NPY shape is invalid or exceeds dimensional limits")
    item_count = math.prod(shape)
    if item_count > max_items:
        raise ValueError(f"NPY item count exceeds {max_items}")
    return NpyHeader(
        version=version,
        dtype=dtype,
        shape=shape,
        item_size=item_size,
        data_offset=stream.tell(),
        item_count=item_count,
        payload_bytes=item_count * item_size,
    )


def _item_size(dtype: str) -> int:
    match = _DTYPE_RE.fullmatch(dtype)
    if not match:
        raise ValueError(f"unsupported NPY dtype: {dtype}")
    endian, kind, size_raw = match.groups()
    size = int(size_raw)
    if (kind, size) not in _STRUCT_CODES:
        raise ValueError(f"unsupported NPY dtype: {dtype}")
    if endian == "|" and size != 1:
        raise ValueError(f"invalid byte-order-independent NPY dtype: {dtype}")
    return size


def _struct_format(dtype: str) -> str:
    match = _DTYPE_RE.fullmatch(dtype)
    if not match:
        raise ValueError(f"unsupported NPY dtype: {dtype}")
    endian, kind, size_raw = match.groups()
    size = int(size_raw)
    code = _STRUCT_CODES.get((kind, size))
    if code is None:
        raise ValueError(f"unsupported NPY dtype: {dtype}")
    prefix = {"<": "<", ">": ">", "=": "=", "|": "="}[endian]
    return prefix + code


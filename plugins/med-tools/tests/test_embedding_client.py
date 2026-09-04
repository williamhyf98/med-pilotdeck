from __future__ import annotations

import unittest
from unittest.mock import patch

from server.rag.embedding_client import embed_texts


class _Response:
    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return {"data": [{"embedding": [0.25, -0.5]}]}


class _Client:
    init_kwargs: dict = {}

    def __init__(self, **kwargs) -> None:
        type(self).init_kwargs = kwargs

    def __enter__(self) -> "_Client":
        return self

    def __exit__(self, *args) -> None:
        return None

    def post(self, *args, **kwargs) -> _Response:
        return _Response()


class EmbeddingClientTests(unittest.TestCase):
    def test_loopback_client_does_not_inherit_proxy_environment(self) -> None:
        with patch("server.rag.embedding_client.httpx.Client", _Client):
            vectors = embed_texts(["样本文本"])
        self.assertEqual(vectors, [[0.25, -0.5]])
        self.assertFalse(_Client.init_kwargs["trust_env"])


if __name__ == "__main__":
    unittest.main()

"""Stream reception is internal: only one complete report becomes user-visible."""

import os

from .evidence import build_messages


def collect_report(stream):
    parts = []
    finish = None
    size = 0
    for chunk in stream:
        if not chunk.choices:
            continue
        choice = chunk.choices[0]
        if choice.delta.content:
            parts.append(choice.delta.content)
            size += len(choice.delta.content)
            if size > 100000:
                raise ValueError("Answer exceeds report size limit")
        if choice.finish_reason:
            finish = choice.finish_reason
    report = "".join(parts).strip()
    if not report or finish != "stop":
        raise ValueError("Answer model returned empty or incomplete report")
    return report


def generate_report(question, evidence):
    import httpx
    from openai import OpenAI

    thinking = os.environ.get("DEEPCHEST_ENABLE_THINKING", "auto")
    options = {}
    if thinking in ("0", "1"):
        options["extra_body"] = {
            "chat_template_kwargs": {"enable_thinking": thinking == "1"}
        }
    with OpenAI(
        base_url=os.environ["FINAL_TEST_OPENAI_BASE_URL"],
        api_key=os.environ.get("OPENAI_API_KEY") or "EMPTY",
        timeout=httpx.Timeout(
            float(os.environ.get("DEEPCHEST_ANSWER_READ_TIMEOUT", "300")), connect=15
        ),
        max_retries=0,
        http_client=httpx.Client(trust_env=False),
    ) as client:
        with client.chat.completions.create(
            model=os.environ["FINAL_TEST_OPENAI_MODEL"],
            messages=build_messages(question, evidence),
            max_tokens=6000,
            temperature=0.2,
            stream=True,
            **options
        ) as stream:
            return collect_report(stream)

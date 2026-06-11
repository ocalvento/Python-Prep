import random
import anthropic
from . import config

_client = None


def _get_client() -> anthropic.Anthropic:
    global _client
    if _client is None:
        _client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
    return _client


def generate_post(topic: str | None = None) -> str:
    if topic is None:
        topic = random.choice(config.POST_TOPICS)

    client = _get_client()

    response = client.messages.create(
        model="claude-opus-4-8",
        max_tokens=1024,
        thinking={"type": "adaptive"},
        system=(
            "You are an expert LinkedIn content creator who writes engaging, professional posts. "
            "Your posts are insightful, concise, and encourage meaningful discussion. "
            "You use relevant emojis sparingly and add 3-5 relevant hashtags at the end. "
            f"Keep posts under {config.MAX_POST_LENGTH} characters. "
            "Write in a conversational yet professional tone. Do not use generic filler phrases."
        ),
        messages=[
            {
                "role": "user",
                "content": (
                    f"Write a LinkedIn post about: {topic.strip()}\n\n"
                    "Make it engaging and thought-provoking. Include a hook in the first line, "
                    "share a concrete insight or tip, and end with a question to spark discussion."
                ),
            }
        ],
    )

    for block in response.content:
        if block.type == "text":
            return block.text.strip()

    raise ValueError("No text content in Claude response")

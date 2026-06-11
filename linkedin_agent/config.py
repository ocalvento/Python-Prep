import os
from dotenv import load_dotenv

load_dotenv()


ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")
LINKEDIN_ACCESS_TOKEN = os.getenv("LINKEDIN_ACCESS_TOKEN")
LINKEDIN_PERSON_URN = os.getenv("LINKEDIN_PERSON_URN")

POST_TOPICS = os.getenv(
    "POST_TOPICS",
    "Python programming,Software engineering best practices,Career growth in tech,AI and machine learning trends"
).split(",")

SCHEDULE_HOUR = int(os.getenv("SCHEDULE_HOUR", "9"))
SCHEDULE_MINUTE = int(os.getenv("SCHEDULE_MINUTE", "0"))
SCHEDULE_DAYS = os.getenv("SCHEDULE_DAYS", "mon,wed,fri")

MAX_POST_LENGTH = int(os.getenv("MAX_POST_LENGTH", "1300"))

LINKEDIN_API_BASE = "https://api.linkedin.com/v2"


def validate_config():
    missing = []
    if not ANTHROPIC_API_KEY:
        missing.append("ANTHROPIC_API_KEY")
    if not LINKEDIN_ACCESS_TOKEN:
        missing.append("LINKEDIN_ACCESS_TOKEN")
    if not LINKEDIN_PERSON_URN:
        missing.append("LINKEDIN_PERSON_URN")
    if missing:
        raise ValueError(f"Missing required environment variables: {', '.join(missing)}")

import requests
from . import config


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {config.LINKEDIN_ACCESS_TOKEN}",
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
    }


def get_profile() -> dict:
    """Fetch the authenticated member's profile to verify credentials."""
    url = f"{config.LINKEDIN_API_BASE}/me"
    response = requests.get(url, headers=_headers(), timeout=10)
    response.raise_for_status()
    return response.json()


def publish_post(text: str) -> dict:
    """Publish a text post to LinkedIn using the UGC Posts API."""
    url = f"{config.LINKEDIN_API_BASE}/ugcPosts"

    payload = {
        "author": f"urn:li:person:{config.LINKEDIN_PERSON_URN}",
        "lifecycleState": "PUBLISHED",
        "specificContent": {
            "com.linkedin.ugc.ShareContent": {
                "shareCommentary": {
                    "text": text,
                },
                "shareMediaCategory": "NONE",
            }
        },
        "visibility": {
            "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
        },
    }

    response = requests.post(url, json=payload, headers=_headers(), timeout=15)
    response.raise_for_status()
    return response.json()

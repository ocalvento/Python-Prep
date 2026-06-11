"""LinkedIn Auto-Posting Agent entry point."""
import argparse
import logging
import sys
from . import config
from .content_generator import generate_post
from .linkedin_client import get_profile, publish_post
from .scheduler import build_scheduler, post_job

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger(__name__)


def cmd_run(args: argparse.Namespace) -> None:
    config.validate_config()
    logger.info("Starting LinkedIn Auto-Posting Agent scheduler...")
    scheduler = build_scheduler()
    try:
        scheduler.start()
    except (KeyboardInterrupt, SystemExit):
        logger.info("Scheduler stopped.")


def cmd_post_now(args: argparse.Namespace) -> None:
    config.validate_config()
    topic = args.topic or None
    logger.info("Posting immediately. Topic: %s", topic or "random")
    post_job(topic=topic)


def cmd_preview(args: argparse.Namespace) -> None:
    config.validate_config()
    topic = args.topic or None
    logger.info("Generating preview (not publishing). Topic: %s", topic or "random")
    text = generate_post(topic)
    print("\n" + "=" * 60)
    print("GENERATED POST PREVIEW")
    print("=" * 60)
    print(text)
    print("=" * 60)
    print(f"Character count: {len(text)}")


def cmd_verify(args: argparse.Namespace) -> None:
    config.validate_config()
    logger.info("Verifying LinkedIn credentials...")
    profile = get_profile()
    first = profile.get("localizedFirstName", "")
    last = profile.get("localizedLastName", "")
    logger.info("Connected as: %s %s", first, last)
    print(f"\nConnected to LinkedIn as: {first} {last}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="LinkedIn Auto-Posting Agent powered by Claude AI"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    subparsers.add_parser("run", help="Start the scheduler (blocks until interrupted)")

    post_parser = subparsers.add_parser("post-now", help="Generate and publish a post immediately")
    post_parser.add_argument("--topic", help="Topic for the post (default: random from config)")

    preview_parser = subparsers.add_parser("preview", help="Generate a post preview without publishing")
    preview_parser.add_argument("--topic", help="Topic for the post (default: random from config)")

    subparsers.add_parser("verify", help="Verify LinkedIn API credentials")

    args = parser.parse_args()

    commands = {
        "run": cmd_run,
        "post-now": cmd_post_now,
        "preview": cmd_preview,
        "verify": cmd_verify,
    }
    commands[args.command](args)


if __name__ == "__main__":
    main()

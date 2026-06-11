import logging
from apscheduler.schedulers.blocking import BlockingScheduler
from apscheduler.triggers.cron import CronTrigger
from . import config
from .content_generator import generate_post
from .linkedin_client import publish_post

logger = logging.getLogger(__name__)


def post_job(topic: str | None = None) -> None:
    """Generate content with Claude and publish it to LinkedIn."""
    try:
        logger.info("Generating post content...")
        text = generate_post(topic)
        logger.info("Publishing to LinkedIn...")
        result = publish_post(text)
        post_id = result.get("id", "unknown")
        logger.info("Post published successfully. ID: %s", post_id)
        logger.debug("Post content:\n%s", text)
    except Exception:
        logger.exception("Failed to publish LinkedIn post")


def build_scheduler() -> BlockingScheduler:
    scheduler = BlockingScheduler(timezone="UTC")

    trigger = CronTrigger(
        day_of_week=config.SCHEDULE_DAYS,
        hour=config.SCHEDULE_HOUR,
        minute=config.SCHEDULE_MINUTE,
    )

    scheduler.add_job(post_job, trigger, id="linkedin_post", name="LinkedIn Auto Post")
    logger.info(
        "Scheduler configured: %s at %02d:%02d UTC",
        config.SCHEDULE_DAYS,
        config.SCHEDULE_HOUR,
        config.SCHEDULE_MINUTE,
    )
    return scheduler

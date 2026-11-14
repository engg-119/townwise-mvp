"""Source adapters. Each one maps a file into sales records or inventory events."""

from reorder.ingestion.activity import attach_square_activity, ingest_comp_log, ingest_void_log
from reorder.ingestion.inventory_export import ingest_inventory_export
from reorder.ingestion.invoice import ingest_deliveries
from reorder.ingestion.manual import ingest_phone_notes, ingest_stockout_log
from reorder.ingestion.mapping import (
    clean_daily_mapping,
    square_item_sales_mapping,
    toast_product_mix_mapping,
)
from reorder.ingestion.pos import ingest_pos_export, propose_pos_mapping
from reorder.ingestion.spreadsheet import ingest_count_spreadsheet

__all__ = [
    "attach_square_activity",
    "clean_daily_mapping",
    "ingest_comp_log",
    "ingest_count_spreadsheet",
    "ingest_void_log",
    "ingest_deliveries",
    "ingest_inventory_export",
    "ingest_phone_notes",
    "ingest_pos_export",
    "ingest_stockout_log",
    "propose_pos_mapping",
    "square_item_sales_mapping",
    "toast_product_mix_mapping",
]

**Chat type:** agent

Analyze the relational CSV files in the workspace (catalog.csv, sales-orders.csv, inventory.csv):
1. In `inventory.csv`, sum the stock for each SKU across all warehouses.
2. In `catalog.csv`, compare the total on-hand stock with `reorder_threshold` to identify all SKUs at risk of stockout (`current_stock < reorder_threshold`), and compute the stock deficit (`reorder_threshold - current_stock`) for each at-risk item and the total deficit across all items.
3. Link `sales-orders.csv` with `catalog.csv` by SKU to calculate total sales revenue by category and region.
4. Report:
   - The list of at-risk SKUs with their current stock, threshold, and deficit.
   - The total units needed to bring all inventory back to reorder threshold (total deficit).
   - The summary of regional category sales.

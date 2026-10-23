SELECT
    toStartOfMonth(sold_at) AS month,
    sum(amount) AS revenue,
    count(*) AS orders
FROM demo.sales
GROUP BY month
ORDER BY month;

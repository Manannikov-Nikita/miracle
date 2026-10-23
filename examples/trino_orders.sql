SELECT
    orderstatus,
    count(*) AS orders,
    sum(totalprice) AS revenue
FROM tpch.tiny.orders
GROUP BY orderstatus
ORDER BY orderstatus;

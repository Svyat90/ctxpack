<?php

namespace App\Services;

class OrderService extends BaseService
{
    public function total(array $items): int
    {
        return array_sum(array_column($items, 'price'));
    }
}

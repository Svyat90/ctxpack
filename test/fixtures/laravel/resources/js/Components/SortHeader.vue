<script setup>
defineEmits(['sort']);
</script>

<template>
  <thead><tr><th @click="$emit('sort')">Email</th></tr></thead>
</template>

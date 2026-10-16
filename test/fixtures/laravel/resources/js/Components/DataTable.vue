<script setup>
import debounce from 'lodash/debounce';
import SortHeader from './SortHeader.vue';

defineProps({ search: String, url: String });
const reload = debounce(() => {}, 300);
</script>

<template>
  <table>
    <SortHeader @sort="reload" />
  </table>
</template>

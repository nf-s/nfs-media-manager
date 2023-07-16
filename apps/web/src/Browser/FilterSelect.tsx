import { Index } from "flexsearch";
import React, { useContext, useMemo, useState } from "react";
import Select, { components } from "react-select";
import {
  FilterState,
  FilterStateContext,
  TextFilterValueWithLabel,
} from "../Table/FilterState.js";

export function FilterSelect<T>() {
  const filterState = useContext<FilterState<T> | undefined>(
    FilterStateContext
  );

  const [filterInputValue, setFilterInputValue] = useState("");

  const filterSearchIndex = useMemo(() => {
    const index = new Index({ tokenize: "full", preset: "score" });

    for (let i = 0; i < (filterState?.filterData?.length ?? 0); i++) {
      const filter = filterState?.filterData?.[i];
      if (filter) index.add(i, filter.label ?? filter.value);
    }

    return index;
  }, [filterState?.filterData]);

  const filteredOptions: TextFilterValueWithLabel<T>[] = useMemo(() => {
    if (!filterInputValue || !filterSearchIndex) {
      return filterState?.filterData ?? [];
    }

    const searchResults = filterSearchIndex.search(filterInputValue);

    const results: TextFilterValueWithLabel<T>[] = [];

    searchResults.forEach((fieldResult) => {
      if (
        typeof fieldResult === "number" &&
        filterState?.filterData?.[fieldResult]
      ) {
        results.push(filterState.filterData[fieldResult]);
      }
    });

    return results.sort((a, b) => b.count - a.count);
  }, [filterInputValue, filterSearchIndex, filterState?.filterData]);

  const slicedOptions = useMemo(() => {
    return filteredOptions.slice(0, 500);
  }, [filteredOptions]);

  return (
    <Select
      components={{
        MultiValueLabel: (props) => {
          function handleMultiValueClick(e: React.MouseEvent) {
            e.stopPropagation();
            e.preventDefault();

            const clickedFilter = props.data as
              | TextFilterValueWithLabel<T>
              | undefined;

            if (filterState?.activeFilters && clickedFilter) {
              // Normal -> exclude -> intersection -> normal
              if (clickedFilter.exclude) {
                clickedFilter.exclude = undefined;
                clickedFilter.intersection = true;
              } else if (clickedFilter.intersection) {
                clickedFilter.exclude = undefined;
                clickedFilter.intersection = undefined;
              } else {
                clickedFilter.exclude = true;
                clickedFilter.intersection = undefined;
              }
              filterState.activeFiltersDispatch({
                type: "add",
                value: clickedFilter,
              });
            }
          }

          return (
            <div onClick={(e) => handleMultiValueClick(e)}>
              <components.MultiValueLabel {...props} />
            </div>
          );
        },
      }}
      placeholder="Filter"
      className={"filter-select"}
      value={filterState?.activeFilters}
      isMulti
      onChange={(filter) => {
        filterState?.activeFiltersDispatch({
          type: "set",
          values: filter.map((f) => ({ ...f })),
        });
      }}
      options={slicedOptions}
      inputValue={filterInputValue}
      onInputChange={(value, action) => {
        if (action.action !== "set-value") {
          setFilterInputValue(value);
        }
      }}
      filterOption={() => true} // disable native filter
      isClearable={true}
      closeMenuOnSelect={false}
      styles={{
        valueContainer: (base) => ({
          ...base,
          maxHeight: "36px",
          ":hover": { maxHeight: "none" },
        }),
        multiValue: (styles, { data }) => {
          const color = data.exclude
            ? "rgba(255,0,0,.3)"
            : data.intersection
            ? "rgba(255,0,255,.3)"
            : "rgba(0,0,255,.3)";
          return {
            ...styles,
            backgroundColor: color,
          };
        },
        // multiValueLabel: (styles, { data }) => ({
        //   ...styles,
        //   color: data.color,
        // }),
        // multiValueRemove: (styles, { data }) => ({
        //   ...styles,
        //   color: data.color,
        //   ':hover': {
        //     backgroundColor: data.color,
        //     color: 'white',
        //   },
        // })
      }}
      theme={(theme) => ({
        ...theme,
        colors: {
          ...theme.colors,
          primary25: "#00ffab24",
          primary50: "#00ffab50",
          primary75: "#00ffab",
          primary: "#00c583",
        },
      })}
    />
  );
}

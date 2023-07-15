import { faArrowUpRightFromSquare } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import type { SizeProp } from "@fortawesome/fontawesome-svg-core";
import React from "react";

export default function LinkIcon(props: { size?: SizeProp }) {
  return (
    <>
      &nbsp;
      <FontAwesomeIcon icon={faArrowUpRightFromSquare} {...props} />
    </>
  );
}

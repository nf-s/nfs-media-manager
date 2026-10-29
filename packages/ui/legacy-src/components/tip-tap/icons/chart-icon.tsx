import * as React from 'react'

export const ChartIcon = React.memo(
  ({ className, ...props }: React.SVGProps<SVGSVGElement>) => {
    return (
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
        {...props}
      >
        <path
          d="M4 4.5C4 3.94772 3.55228 3.5 3 3.5C2.44772 3.5 2 3.94772 2 4.5V20.5C2 21.0523 2.44772 21.5 3 21.5H19.5C20.0523 21.5 20.5 21.0523 20.5 20.5C20.5 19.9477 20.0523 19.5 19.5 19.5H4V4.5Z"
          fill="currentColor"
        />
        <path
          d="M7.06277 16.2426L10.7318 11.4263L13.3659 13.8391C13.7585 14.1927 14.3495 14.1541 14.6958 13.7517L18.0938 9.81023L19.1329 11.1417C19.4627 11.5643 20.0732 11.6415 20.4958 11.3117C20.9183 10.9819 20.9955 10.3714 20.6657 9.94882L18.8126 7.60111C18.4315 7.12168 17.6972 7.09092 17.2706 7.53318L13.8043 11.1379L11.0747 8.67262C10.6888 8.31433 10.0864 8.34316 9.73632 8.7344L5.73632 13.2344C5.38792 13.6233 5.419 14.2274 5.80786 14.5758C6.19672 14.9242 6.8008 14.8931 7.14919 14.5043L7.06277 16.2426Z"
          fill="currentColor"
        />
        <circle cx="10.75" cy="11.25" r="1.1" fill="currentColor" />
        <circle cx="13.75" cy="13.75" r="1.1" fill="currentColor" />
        <circle cx="18" cy="9.25" r="1.1" fill="currentColor" />
        <circle cx="7.25" cy="15.5" r="1.1" fill="currentColor" />
      </svg>
    )
  },
)

ChartIcon.displayName = 'ChartIcon'
